const BUK_UA = "buki-agent/1.0";

export interface BukConfig {
  tenant: string;
  country: string;
  token: string;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/** 3-minute TTL. HR data changes rarely; cache eliminates repeated full fetches within a session. */
const CACHE_TTL_MS = 3 * 60 * 1000;

/** Max records sent to the LLM per BUK response. Keeps token usage predictable. */
const MAX_RECORDS_FOR_LLM = 50;

const employeeCache = new Map<string, CacheEntry<Array<Record<string, unknown>>>>();
const areaCache = new Map<string, CacheEntry<Map<string, string>>>();
const absencesCache = new Map<string, CacheEntry<Array<Record<string, unknown>>>>();
const vacationsCache = new Map<string, CacheEntry<Array<Record<string, unknown>>>>();

function cacheKey(config: BukConfig): string {
  return `${config.tenant}:${config.country}`;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function bukFetch(config: BukConfig, path: string, timeoutMs = 25_000) {
  const url = `${config.tenant}/api/v1/${config.country}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        auth_token: config.token,
        Accept: "application/json",
        "User-Agent": BUK_UA,
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      console.error("[buk] request timeout", url);
      throw new Error(`BUK API timeout after ${timeoutMs / 1000}s: ${url}`);
    }
    throw err;
  }
  clearTimeout(timer);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[buk] API error", res.status, url, body.slice(0, 200));
    throw new Error(`BUK API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize: lowercase + strip accents so "Julián" matches "julian" */
function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Unwrap BUK array responses (direct array or nested in data/employees/results) */
function unwrapArray(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["data", "employees", "results", "absences", "vacations", "licences"]) {
      if (Array.isArray(obj[key])) return obj[key] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function getEmployeeName(e: Record<string, unknown>): string {
  if (e.full_name) return String(e.full_name);
  const parts = [e.first_name, e.surname, e.second_surname].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return String(e.nombre ?? e.name ?? "—");
}

function formatEmployee(e: Record<string, unknown>, areaMap?: Map<string, string>) {
  const job = e.current_job as Record<string, unknown> | undefined;
  const role = job?.role as Record<string, unknown> | undefined;
  const areaId = String(job?.area_id ?? "");
  return {
    person_id: e.person_id ?? e.id,
    name: getEmployeeName(e),
    document_type: e.document_type,
    document_number: e.document_number,
    email: e.email,
    personal_email: e.personal_email,
    phone: e.phone,
    job_title: role?.name ?? job?.name,
    area: areaMap?.get(areaId) ?? (areaId ? `área_id:${areaId}` : undefined),
    hire_date: e.active_since,
    current_job_start: job?.start_date,
    contract_type: job?.type_of_contract,
    status: e.status,
    health_company: e.health_company,
    pension_fund: (e.custom_attributes as Record<string, unknown>)?.["AFP (Administrador Fondo de Pensiones)"],
    gender: e.gender,
    birthday: e.birthday,
  };
}

// ── Parallel data fetchers with TTL cache ─────────────────────────────────────

/**
 * Fetch ALL employees using parallel pagination.
 * Results are cached for CACHE_TTL_MS to avoid repeated full fetches within a session.
 *
 * Strategy:
 *  1. Return from cache if fresh.
 *  2. Probe page 1. If it has < 100 items, we're done.
 *  3. If page 1 is full (100 items), launch pages 2–12 in parallel with Promise.all.
 *  4. Iterate results in page order, stopping at the first empty or partial page.
 */
async function fetchAllEmployees(config: BukConfig): Promise<Array<Record<string, unknown>>> {
  const key = cacheKey(config);
  const entry = employeeCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    console.log("[buk] employees served from cache");
    return entry.data;
  }

  const t0 = Date.now();

  // Probe page 1
  const firstData = await bukFetch(config, "/employees?page=1&page_size=100");
  const firstBatch = unwrapArray(firstData);
  let all = [...firstBatch];

  if (firstBatch.length === 100) {
    // More pages likely exist — fetch pages 2–12 in parallel
    const MAX_PAGES = 12;
    const remainingResults = await Promise.all(
      Array.from({ length: MAX_PAGES - 1 }, (_, i) => i + 2).map((p) =>
        bukFetch(config, `/employees?page=${p}&page_size=100`)
          .then(unwrapArray)
          .catch((): Array<Record<string, unknown>> => [])
      )
    );
    for (const batch of remainingResults) {
      if (batch.length === 0) break;       // empty page = no more data
      all = all.concat(batch);
      if (batch.length < 100) break;       // partial page = last page
    }
  }

  console.log(`[buk] fetched ${all.length} employees in ${Date.now() - t0}ms (cached for ${CACHE_TTL_MS / 1000}s)`);
  employeeCache.set(key, { data: all, expiresAt: Date.now() + CACHE_TTL_MS });
  return all;
}

/** Fetch area id→name map with TTL cache. */
async function fetchAreaMap(config: BukConfig): Promise<Map<string, string>> {
  const key = cacheKey(config);
  const entry = areaCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;

  const map = new Map<string, string>();
  try {
    const data = await bukFetch(config, "/areas");
    const areas = unwrapArray(data);
    for (const a of areas) {
      map.set(String(a.id), String(a.name ?? a.nombre ?? ""));
    }
  } catch { /* areas endpoint is optional */ }

  areaCache.set(key, { data: map, expiresAt: Date.now() + CACHE_TTL_MS });
  return map;
}

/** Fetch all absences with TTL cache. */
async function fetchAllAbsences(config: BukConfig): Promise<Array<Record<string, unknown>>> {
  const key = cacheKey(config);
  const entry = absencesCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    console.log("[buk] absences served from cache");
    return entry.data;
  }
  const raw = await bukFetch(config, "/absences");
  const data = unwrapArray(raw);
  absencesCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

/** Fetch all vacations with TTL cache. */
async function fetchAllVacations(config: BukConfig): Promise<Array<Record<string, unknown>>> {
  const key = cacheKey(config);
  const entry = vacationsCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    console.log("[buk] vacations served from cache");
    return entry.data;
  }
  const raw = await bukFetch(config, "/vacations");
  const data = unwrapArray(raw);
  vacationsCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

/** Pure — count active/inactive from a pre-fetched employee array (no HTTP call). */
function countByStatus(employees: Array<Record<string, unknown>>): {
  active: number;
  inactive: number;
  total: number;
} {
  let active = 0, inactive = 0;
  for (const e of employees) {
    if (String(e.status ?? "").toLowerCase() === "activo") active++;
    else inactive++;
  }
  return { active, inactive, total: active + inactive };
}

/** Pure — build id→displayName map from a pre-fetched employee array. */
function buildNameMap(employees: Array<Record<string, unknown>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of employees) {
    const id = String(e.person_id ?? e.id);
    const status = String(e.status ?? "").toLowerCase();
    map.set(id, `${getEmployeeName(e)}${status !== "activo" ? ` (${e.status})` : ""}`);
  }
  return map;
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function executeBukTool(
  toolName: string,
  args: Record<string, unknown>,
  config: BukConfig
): Promise<Record<string, unknown>> {
  if (!config?.tenant || !config?.token) {
    throw new Error("Integración BUK no configurada. Reconéctala en Configuración.");
  }

  switch (toolName) {

    case "buk_list_employees": {
      const filterName    = args.name as string | undefined;
      const filterArea    = args.area as string | undefined;
      const page          = (args.page as number) ?? 1;
      const countOnly     = !!(args.count_only);
      const includeInactive = !!(args.include_inactive);

      // Fetch employees and areas in parallel — both use the cache on subsequent calls
      const [allEmployees, areaMap] = await Promise.all([
        fetchAllEmployees(config),
        fetchAreaMap(config),
      ]);

      // Pure helpers rely on in-memory data — no extra HTTP calls
      const counts = countByStatus(allEmployees);

      if (countOnly) {
        return {
          active_employees:   counts.active,
          inactive_employees: counts.inactive,
          total_employees:    counts.total,
        };
      }

      const nameWords = filterName ? normalize(filterName).split(/\s+/).filter(Boolean) : [];
      const areaWords = filterArea ? normalize(filterArea).split(/\s+/).filter(Boolean) : [];
      const isSearching = nameWords.length > 0 || areaWords.length > 0;

      function isActive(e: Record<string, unknown>): boolean {
        return String(e.status ?? "").toLowerCase() === "activo";
      }
      function matchesName(e: Record<string, unknown>): boolean {
        if (nameWords.length === 0) return true;
        return nameWords.every((w) => normalize(getEmployeeName(e)).includes(w));
      }
      function matchesArea(e: Record<string, unknown>): boolean {
        if (areaWords.length === 0) return true;
        const job = e.current_job as Record<string, unknown> | undefined;
        const areaId = String(job?.area_id ?? "");
        const hay = normalize(areaMap.get(areaId) ?? "");
        return areaWords.every((w) => hay.includes(w));
      }

      let employees: Array<Record<string, unknown>>;

      if (isSearching) {
        employees = allEmployees.filter(
          (e) => (includeInactive || isActive(e)) && matchesName(e) && matchesArea(e)
        );
      } else {
        // In-memory pagination over active (or all) employees
        const pool = allEmployees.filter((e) => includeInactive || isActive(e));
        const offset = (page - 1) * 25;
        employees = pool.slice(offset, offset + 25);
      }

      const limited = employees.slice(0, 25);

      return {
        active_employees:   counts.active,
        inactive_employees: counts.inactive,
        total_employees:    counts.total,
        ...(isSearching ? {} : { page }),
        employees: limited.map((e) => formatEmployee(e, areaMap)),
      };
    }

    case "buk_get_employee": {
      if (!args.id) throw new Error("Se requiere el ID del empleado");

      // Try direct API lookup first (faster for known IDs)
      const res1 = await bukFetch(config, `/employees/${args.id}`).catch(() => null);
      let e: Record<string, unknown> | null = null;
      if (res1 && !Array.isArray(res1) && (res1 as Record<string, unknown>).person_id) {
        e = res1 as Record<string, unknown>;
      }

      // Fallback: search in cached full employee list (no extra HTTP calls)
      if (!e) {
        const all = await fetchAllEmployees(config);
        e = all.find(
          (emp) => String(emp.person_id) === String(args.id) || String(emp.id) === String(args.id)
        ) ?? null;
      }

      if (!e) throw new Error(`Empleado con ID ${args.id} no encontrado`);

      const areaMap = await fetchAreaMap(config);
      const job  = e.current_job as Record<string, unknown> | undefined;
      const role = job?.role as Record<string, unknown> | undefined;
      const jobs = (e.jobs as Array<Record<string, unknown>> | undefined) ?? [];
      const areaId = String(job?.area_id ?? "");

      const firstJobStart = jobs.length > 0
        ? jobs.reduce((earliest, j) =>
            (j.start_date as string) < (earliest.start_date as string) ? j : earliest
          ).start_date
        : e.active_since;

      return {
        person_id:          e.person_id,
        name:               getEmployeeName(e),
        document_type:      e.document_type,
        document_number:    e.document_number,
        email:              e.email,
        personal_email:     e.personal_email,
        phone:              e.phone,
        job_title:          role?.name ?? job?.name,
        area:               areaMap.get(areaId) ?? (areaId ? `área_id:${areaId}` : undefined),
        hire_date:          firstJobStart,
        current_job_start:  job?.start_date,
        contract_type:      job?.type_of_contract,
        status:             e.status,
        gender:             e.gender,
        birthday:           e.birthday,
        address:            e.address,
        district:           e.district,
        health_company:     e.health_company,
        pension_fund:       (e.custom_attributes as Record<string, unknown>)?.["AFP (Administrador Fondo de Pensiones)"],
        pension_regime:     e.pension_regime,
        job_history: jobs.map((j) => ({
          start_date:    j.start_date,
          end_date:      j.end_date ?? "actual",
          role:          (j.role as Record<string, unknown>)?.name,
          contract_type: j.type_of_contract,
        })),
      };
    }

    case "buk_list_absences": {
      // Fetch absences and employee name map in parallel — both use cache on subsequent calls
      const [data, allEmployees] = await Promise.all([
        fetchAllAbsences(config),
        fetchAllEmployees(config),
      ]);
      const nameMap = buildNameMap(allEmployees);
      const since   = args.since_date as string | undefined;
      const filtered = since
        ? data.filter((a) => (a.start_date as string) >= since)
        : data;

      // Sort most recent first, then cap to MAX_RECORDS_FOR_LLM to keep token usage low
      const sorted = [...filtered].sort((a, b) =>
        String(b.start_date ?? "").localeCompare(String(a.start_date ?? ""))
      );
      const limited = sorted.slice(0, MAX_RECORDS_FOR_LLM);

      return {
        total: filtered.length,
        showing: limited.length,
        ...(filtered.length > MAX_RECORDS_FOR_LLM
          ? { note: `Mostrando los ${MAX_RECORDS_FOR_LLM} más recientes de ${filtered.length}. Usa since_date para filtrar por fecha.` }
          : {}),
        absences: limited.map((a) => ({
          id:            a.id,
          employee_id:   a.employee_id,
          employee_name: nameMap.get(String(a.employee_id)) ?? "—",
          type:          a.type,
          start_date:    a.start_date,
          end_date:      a.end_date,
          status:        a.status,
        })),
      };
    }

    case "buk_list_vacations": {
      if (args.employee_id) {
        const data = await bukFetch(config, `/employees/${args.employee_id}/vacations`) as Record<string, unknown>;
        return { employee_id: args.employee_id, vacations: unwrapArray(data) };
      }
      // Fetch vacations and employee name map in parallel — both use cache on subsequent calls
      const [data, allEmployees] = await Promise.all([
        fetchAllVacations(config),
        fetchAllEmployees(config),
      ]);
      const nameMap = buildNameMap(allEmployees);

      // Sort most recent first, cap to MAX_RECORDS_FOR_LLM
      const sorted = [...data].sort((a, b) =>
        String(b.start_date ?? "").localeCompare(String(a.start_date ?? ""))
      );
      const limited = sorted.slice(0, MAX_RECORDS_FOR_LLM);

      return {
        total: data.length,
        showing: limited.length,
        ...(data.length > MAX_RECORDS_FOR_LLM
          ? { note: `Mostrando las ${MAX_RECORDS_FOR_LLM} más recientes de ${data.length}.` }
          : {}),
        vacations: limited.map((v) => ({
          id:            v.id,
          employee_id:   v.employee_id,
          employee_name: nameMap.get(String(v.employee_id)) ?? "—",
          start_date:    v.start_date,
          end_date:      v.end_date,
          status:        v.status,
          days:          v.days,
        })),
      };
    }

    case "buk_list_licenses": {
      // Fetch absences and employee name map in parallel — both use cache on subsequent calls
      const [all, allEmployees] = await Promise.all([
        fetchAllAbsences(config),
        fetchAllEmployees(config),
      ]);
      const nameMap = buildNameMap(allEmployees);
      const licenceTypes = ["licencia", "impedimento", "permiso", "licence", "permission"];
      const data = all.filter((a) =>
        licenceTypes.some((t) => normalize(String(a.type ?? "")).includes(t))
      );

      // Sort most recent first, cap to MAX_RECORDS_FOR_LLM
      const sorted = [...data].sort((a, b) =>
        String(b.start_date ?? "").localeCompare(String(a.start_date ?? ""))
      );
      const limited = sorted.slice(0, MAX_RECORDS_FOR_LLM);

      return {
        total: data.length,
        showing: limited.length,
        note: `Licencias, impedimentos y permisos extraídos de ausencias.${data.length > MAX_RECORDS_FOR_LLM ? ` Mostrando los ${MAX_RECORDS_FOR_LLM} más recientes de ${data.length}.` : ""}`,
        licenses: limited.map((l) => ({
          id:            l.id,
          employee_id:   l.employee_id,
          employee_name: nameMap.get(String(l.employee_id)) ?? "—",
          type:          l.type,
          start_date:    l.start_date,
          end_date:      l.end_date,
          status:        l.status,
        })),
      };
    }

    default:
      throw new Error(`Unknown BUK tool: ${toolName}`);
  }
}
