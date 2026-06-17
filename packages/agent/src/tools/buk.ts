const BUK_UA = "buki-agent/1.0";

export interface BukConfig {
  tenant: string;
  country: string;
  token: string;
}

async function bukFetch(config: BukConfig, path: string) {
  const url = `${config.tenant}/api/v1/${config.country}${path}`;
  const res = await fetch(url, {
    headers: {
      auth_token: config.token,
      Accept: "application/json",
      "User-Agent": BUK_UA,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[buk] API error", res.status, url, body.slice(0, 200));
    throw new Error(`BUK API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

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

/** Fetch all employees (up to 500) and return a person_id → name map (all statuses for cross-reference) */
async function buildEmployeeNameMap(config: BukConfig): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let page = 1; page <= 6; page++) {
    const data = await bukFetch(config, `/employees?page=${page}&page_size=100`);
    const batch = unwrapArray(data);
    if (batch.length === 0) break;
    for (const e of batch) {
      const id = String(e.person_id ?? e.id);
      const status = String(e.status ?? "").toLowerCase();
      map.set(id, `${getEmployeeName(e)}${status !== "activo" ? ` (${e.status})` : ""}`);
    }
    if (batch.length < 100) break;
  }
  return map;
}

/** Fetch all areas and return area_id → name map */
async function buildAreaMap(config: BukConfig): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const data = await bukFetch(config, "/areas");
    const areas = unwrapArray(data);
    for (const a of areas) {
      map.set(String(a.id), String(a.name ?? a.nombre ?? ""));
    }
  } catch { /* areas endpoint optional */ }
  return map;
}

/** Fetch all employees and return count breakdown by status */
async function countEmployeesByStatus(config: BukConfig): Promise<{ active: number; inactive: number; total: number }> {
  let active = 0, inactive = 0;
  for (let page = 1; page <= 12; page++) {
    const data = await bukFetch(config, `/employees?page=${page}&page_size=100`);
    const batch = unwrapArray(data);
    for (const e of batch) {
      if (String(e.status ?? "").toLowerCase() === "activo") active++;
      else inactive++;
    }
    if (batch.length < 100) break;
  }
  return { active, inactive, total: active + inactive };
}

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
      const filterName = (args.name as string | undefined);
      const filterArea = (args.area as string | undefined);
      const page = (args.page as number) ?? 1;
      const countOnly = !!(args.count_only);

      // If only count requested, return full breakdown
      if (countOnly) {
        const counts = await countEmployeesByStatus(config);
        return {
          active_employees: counts.active,
          inactive_employees: counts.inactive,
          total_employees: counts.total,
        };
      }

      // By default only show active employees; pass include_inactive=true to see all
      const includeInactive = !!(args.include_inactive);
      const nameWords = filterName ? normalize(filterName).split(/\s+/).filter(Boolean) : [];
      const areaWords = filterArea ? normalize(filterArea).split(/\s+/).filter(Boolean) : [];
      const isSearching = nameWords.length > 0 || areaWords.length > 0;

      const areaMap = await buildAreaMap(config);

      function matchesName(e: Record<string, unknown>): boolean {
        if (nameWords.length === 0) return true;
        return nameWords.every((w) => normalize(getEmployeeName(e)).includes(w));
      }

      function matchesArea(e: Record<string, unknown>): boolean {
        if (areaWords.length === 0) return true;
        const job = e.current_job as Record<string, unknown> | undefined;
        const areaId = String(job?.area_id ?? "");
        const areaName = areaMap.get(areaId) ?? "";
        const hay = normalize(areaName);
        return areaWords.every((w) => hay.includes(w));
      }

      function isActive(e: Record<string, unknown>): boolean {
        return String(e.status ?? "").toLowerCase() === "activo";
      }

      let employees: Array<Record<string, unknown>> = [];
      let counts: { active: number; inactive: number; total: number } | undefined;

      if (isSearching) {
        for (let currentPage = 1; currentPage <= 12; currentPage++) {
          const data = await bukFetch(config, `/employees?page=${currentPage}&page_size=100`);
          const batch = unwrapArray(data);
          if (batch.length === 0) break;
          employees = employees.concat(batch);
          const matchCount = employees
            .filter((e) => (includeInactive || isActive(e)) && matchesName(e) && matchesArea(e)).length;
          if (matchCount > 0 && batch.length < 100) break;
          if (batch.length < 100) break;
        }
        employees = employees.filter((e) =>
          (includeInactive || isActive(e)) && matchesName(e) && matchesArea(e)
        );
      } else {
        const [data, c] = await Promise.all([
          bukFetch(config, `/employees?page=${page}&page_size=25`),
          countEmployeesByStatus(config),
        ]);
        counts = c;
        employees = unwrapArray(data).filter((e) => includeInactive || isActive(e));
      }

      const limited = employees.slice(0, 25);

      return {
        ...(counts ? {
          active_employees: counts.active,
          inactive_employees: counts.inactive,
          total_employees: counts.total,
        } : { showing_count: limited.length }),
        ...(isSearching ? {} : { page }),
        employees: limited.map((e) => formatEmployee(e, areaMap)),
      };
    }

    case "buk_get_employee": {
      if (!args.id) throw new Error("Se requiere el ID del empleado");
      const areaMap = await buildAreaMap(config);

      // Try direct lookup first
      const res1 = await bukFetch(config, `/employees/${args.id}`).catch(() => null);
      let e: Record<string, unknown> | null = null;
      if (res1 && !Array.isArray(res1) && (res1 as Record<string, unknown>).person_id) {
        e = res1 as Record<string, unknown>;
      }

      // Fallback: find in full employee list (paginated)
      if (!e) {
        for (let page = 1; page <= 12; page++) {
          const data = await bukFetch(config, `/employees?page=${page}&page_size=100`);
          const batch = unwrapArray(data);
          if (batch.length === 0) break;
          const found = batch.find(
            (emp) => String(emp.person_id) === String(args.id) || String(emp.id) === String(args.id)
          );
          if (found) { e = found; break; }
          if (batch.length < 100) break;
        }
      }

      if (!e) throw new Error(`Empleado con ID ${args.id} no encontrado`);

      const job = e.current_job as Record<string, unknown> | undefined;
      const role = job?.role as Record<string, unknown> | undefined;
      const jobs = (e.jobs as Array<Record<string, unknown>> | undefined) ?? [];
      const areaId = String(job?.area_id ?? "");

      const firstJobStart = jobs.length > 0
        ? jobs.reduce((earliest, j) =>
            (j.start_date as string) < (earliest.start_date as string) ? j : earliest
          ).start_date
        : e.active_since;

      return {
        person_id: e.person_id,
        name: getEmployeeName(e),
        document_type: e.document_type,
        document_number: e.document_number,
        email: e.email,
        personal_email: e.personal_email,
        phone: e.phone,
        job_title: role?.name ?? job?.name,
        area: areaMap.get(areaId) ?? (areaId ? `área_id:${areaId}` : undefined),
        hire_date: firstJobStart,
        current_job_start: job?.start_date,
        contract_type: job?.type_of_contract,
        status: e.status,
        gender: e.gender,
        birthday: e.birthday,
        address: e.address,
        district: e.district,
        health_company: e.health_company,
        pension_fund: (e.custom_attributes as Record<string, unknown>)?.["AFP (Administrador Fondo de Pensiones)"],
        pension_regime: e.pension_regime,
        job_history: jobs.map((j) => ({
          start_date: j.start_date,
          end_date: j.end_date ?? "actual",
          role: (j.role as Record<string, unknown>)?.name,
          contract_type: j.type_of_contract,
        })),
      };
    }

    case "buk_list_absences": {
      const raw = await bukFetch(config, "/absences");
      const data = unwrapArray(raw);
      // Build employee name map to resolve IDs → names
      const nameMap = await buildEmployeeNameMap(config);
      // Optional: filter by recent (last 12 months) if data seems old
      const since = args.since_date as string | undefined;
      const filtered = since
        ? data.filter((a) => (a.start_date as string) >= since)
        : data;
      return {
        total: filtered.length,
        absences: filtered.map((a) => ({
          id: a.id,
          employee_id: a.employee_id,
          employee_name: nameMap.get(String(a.employee_id)) ?? "—",
          type: a.type,
          start_date: a.start_date,
          end_date: a.end_date,
          status: a.status,
        })),
      };
    }

    case "buk_list_vacations": {
      if (args.employee_id) {
        const data = await bukFetch(config, `/employees/${args.employee_id}/vacations`) as Record<string, unknown>;
        return { employee_id: args.employee_id, vacations: unwrapArray(data) };
      }
      const raw = await bukFetch(config, "/vacations");
      const data = unwrapArray(raw);
      const nameMap = await buildEmployeeNameMap(config);
      return {
        total: data.length,
        vacations: data.map((v) => ({
          id: v.id,
          employee_id: v.employee_id,
          employee_name: nameMap.get(String(v.employee_id)) ?? "—",
          start_date: v.start_date,
          end_date: v.end_date,
          status: v.status,
          days: v.days,
        })),
      };
    }

    case "buk_list_licenses": {
      // Licences in BUK Colombia are tracked under /absences with type "Licencia"/"Impedimento"
      // The /employees/licences endpoint fails with auth; use absences filtered by type instead
      const raw = await bukFetch(config, "/absences");
      const all = unwrapArray(raw);
      const nameMap = await buildEmployeeNameMap(config);
      const licenceTypes = ["licencia", "impedimento", "permiso", "licence", "permission"];
      const data = all.filter((a) =>
        licenceTypes.some((t) => normalize(String(a.type ?? "")).includes(t))
      );
      return {
        total: data.length,
        note: "Licencias, impedimentos y permisos extraídos de los registros de ausencias.",
        licenses: data.map((l) => ({
          id: l.id,
          employee_id: l.employee_id,
          employee_name: nameMap.get(String(l.employee_id)) ?? "—",
          type: l.type,
          start_date: l.start_date,
          end_date: l.end_date,
          status: l.status,
        })),
      };
    }

    default:
      throw new Error(`Unknown BUK tool: ${toolName}`);
  }
}
