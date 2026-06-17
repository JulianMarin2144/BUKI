import type { ToolDefinition, ToolRisk } from "./index";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
    displayName: "Preferencias del usuario",
    displayDescription: "Consulta tu configuración y preferencias.",
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
    displayName: "Listar herramientas",
    displayDescription: "Muestra qué herramientas tienes habilitadas.",
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
    displayName: "GitHub: listar repos",
    displayDescription: "Lista tus repositorios de GitHub.",
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
    displayName: "GitHub: listar issues",
    displayDescription: "Lista issues de un repositorio.",
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
    displayName: "GitHub: crear issue",
    displayDescription: "Crea un issue nuevo (requiere confirmación).",
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        isPrivate: { type: "boolean", description: "Whether the repository is private" },
      },
      required: ["name"],
    },
    displayName: "GitHub: crear repositorio",
    displayDescription: "Crea un repositorio nuevo en GitHub (requiere confirmación).",
  },
  {
    id: "read_file",
    name: "read_file",
    description:
      "Reads an existing text file from the server filesystem. Use this when you need to inspect source code, config, logs, or any UTF-8 text without changing it. Do NOT use this to create or modify files; use write_file or edit_file instead. Do NOT use this if you only need a directory listing — this tool does not list folders. Parameters: `path` can be absolute or relative (resolved from the server process working directory, same as the bash tool). Optional `offset` is the 1-based start line number (first line is 1). Optional `limit` is the maximum number of lines to return starting at `offset`. If both are omitted, the full file is returned up to a server-enforced maximum. Binary files are not supported. Process: resolve path → read from disk → slice by line range if requested → return JSON. Success: { ok: true, path, content, startLine, endLine, totalLines }. Failure: { ok: false, path, error: { code, message } } with explicit reason (e.g. file not found, file too large, tool disabled).",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path or path relative to the server process working directory." },
        offset: { type: "number", description: "1-based line number to start reading from. Defaults to 1." },
        limit: { type: "number", description: "Maximum number of lines to return starting at offset." },
      },
      required: ["path"],
    },
    displayName: "Leer archivo",
    displayDescription: "Lee un archivo de texto existente dentro del workspace (opcionalmente por rango de líneas). No crea ni modifica archivos.",
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Creates a NEW file with the given UTF-8 content. Use this ONLY when the file does not exist yet. If the file already exists this tool FAILS by design — use edit_file to change existing files. Do not use this to overwrite or patch. Parameters: `path` can be absolute or relative (resolved from the server process working directory, same as the bash tool); `content` is the full file body to write. Process: resolve path → verify file does not already exist → create parent directories → write atomically → return JSON. Success: { ok: true, path, bytesWritten }. Failure: { ok: false, path, error: { code, message } } e.g. file already exists, permission denied, or tool disabled. Human approval required before execution.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path or path relative to the server process working directory. The file must not exist yet." },
        content: { type: "string", description: "Full UTF-8 content to write into the new file." },
      },
      required: ["path", "content"],
    },
    displayName: "Crear archivo",
    displayDescription: "Crea un archivo nuevo con contenido completo. Falla si el archivo ya existe; para cambios usa editar archivo.",
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Edits an EXISTING UTF-8 text file by replacing EXACTLY ONE occurrence of old_string with new_string. Use this when you need to update part of a file without rewriting the whole file. Do NOT use this to create a new file (use write_file). If old_string might match zero or multiple places, add more surrounding context to make it unique. old_string and new_string are literal substrings, not regex. Line endings must match those in the file. Parameters: `path` can be absolute or relative (resolved from the server process working directory, same as the bash tool). Process: resolve path → read file → count occurrences of old_string → if not exactly 1, fail with a clear message (0 found vs N found) → apply replacement → write safely → return JSON. Success: { ok: true, path, replacements: 1 }. Failure: { ok: false, path, error: { code, message } } e.g. file not found, old_string found 0 times, old_string found N>1 times, permission denied, or tool disabled. Human approval required before execution.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path or path relative to the server process working directory. The file must already exist." },
        old_string: { type: "string", description: "Literal substring to find. Must appear exactly once in the file." },
        new_string: { type: "string", description: "Literal string that replaces the single occurrence of old_string." },
      },
      required: ["path", "old_string", "new_string"],
    },
    displayName: "Editar archivo",
    displayDescription: "Reemplaza una única aparición de un fragmento en un archivo existente. No crea archivos nuevos.",
  },
  {
    id: "schedule_task",
    name: "schedule_task",
    description:
      "Creates a scheduled task that will run a given prompt automatically at a specified time or on a recurring cron schedule. For a one-time task provide run_at (ISO 8601 datetime). For a recurring task provide cron_expr (standard 5-field cron expression, e.g. '0 9 * * 1' for every Monday at 9 AM) and optionally timezone (IANA tz, defaults to user timezone). The task will trigger the agent with the given prompt and send the result via Telegram by default. Requires confirmation.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The instruction/prompt the agent will execute when the task fires.",
        },
        schedule_type: {
          type: "string",
          enum: ["one_time", "recurring"],
          description: "Whether this is a single execution or a recurring one.",
        },
        run_at: {
          type: "string",
          description: "ISO 8601 datetime for one_time tasks (e.g. '2026-04-10T09:00:00Z').",
        },
        cron_expr: {
          type: "string",
          description:
            "5-field cron expression for recurring tasks (e.g. '0 9 * * 1' = every Monday 9 AM).",
        },
        timezone: {
          type: "string",
          description: "IANA timezone name (e.g. 'America/Bogota'). Defaults to user timezone.",
        },
      },
      required: ["prompt", "schedule_type"],
    },
    displayName: "Programar tarea",
    displayDescription:
      "Crea una tarea programada que el agente ejecutará automáticamente y notificará por Telegram.",
  },
  {
    id: "buk_list_employees",
    name: "buk_list_employees",
    description: "Lists employees from BUK HR. By default returns only ACTIVE employees. Returns active_employees, inactive_employees, and total_employees counts. When 'name' or 'area' is provided, searches ALL pages. Use count_only=true to get the breakdown of active vs inactive without listing. Use include_inactive=true to include inactive employees. After finding an employee by name, always call buk_get_employee with their person_id for complete details.",
    risk: "low",
    requires_integration: "buk",
    parameters_schema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number for browsing without filters (default 1)" },
        area: { type: "string", description: "Filter by area/department name (searches all pages)" },
        name: { type: "string", description: "Filter by employee name — accent-insensitive, partial words (searches all pages)" },
        count_only: { type: "boolean", description: "Set to true to only return active/inactive/total employee counts" },
        include_inactive: { type: "boolean", description: "Set to true to include inactive employees in results (default false = active only)" },
      },
      required: [],
    },
    displayName: "BUK: listar empleados",
    displayDescription: "Lista los empleados activos de la empresa.",
  },
  {
    id: "buk_get_employee",
    name: "buk_get_employee",
    description: "Gets full profile of a single BUK employee: name, email, phone, document, job title, hire date, contract type, health/pension info. ALWAYS call this after finding an employee with buk_list_employees to get complete data. Use the 'person_id' field from the list result, NOT the job id.",
    risk: "low",
    requires_integration: "buk",
    parameters_schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The person_id of the employee (from buk_list_employees result)" },
      },
      required: ["id"],
    },
    displayName: "BUK: ver empleado",
    displayDescription: "Obtiene el detalle de un empleado por su ID.",
  },
  {
    id: "buk_list_absences",
    name: "buk_list_absences",
    description: "Lists employee absences from BUK. Use to answer questions like 'who was absent this week?' or 'show me recent absences'.",
    risk: "low",
    requires_integration: "buk",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
    displayName: "BUK: listar ausencias",
    displayDescription: "Lista las ausencias de empleados registradas en BUK.",
  },
  {
    id: "buk_list_vacations",
    name: "buk_list_vacations",
    description: "Lists vacation requests or available vacation days from BUK. If employee_id is provided, returns available days for that employee. Otherwise returns all vacation records.",
    risk: "low",
    requires_integration: "buk",
    parameters_schema: {
      type: "object",
      properties: {
        employee_id: { type: "number", description: "Optional employee ID to get available vacation days for a specific employee" },
      },
      required: [],
    },
    displayName: "BUK: listar vacaciones",
    displayDescription: "Lista vacaciones o días disponibles de empleados.",
  },
  {
    id: "buk_list_licenses",
    name: "buk_list_licenses",
    description: "Lists employee licenses and permissions from BUK. Use to answer questions about medical leaves, maternity/paternity leaves, or other official permits.",
    risk: "low",
    requires_integration: "buk",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
    displayName: "BUK: listar licencias",
    displayDescription: "Lista licencias y permisos de empleados registrados en BUK.",
  },
  {
    id: "bash",
    name: "bash",
    description:
      "Use this tool when you need to execute bash commands and interact with the operative system. This tool executes commands in a new or existing terminal and returns the commands text output. The system running is a unix-like O.S.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: { type: "string", description: "Terminal identifier for correlation and logging" },
        prompt: { type: "string", description: "Bash command to execute" },
      },
      required: ["terminal", "prompt"],
    },
    displayName: "Bash",
    displayDescription: "Ejecuta comandos bash en el servidor (riesgo alto, requiere confirmación).",
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
