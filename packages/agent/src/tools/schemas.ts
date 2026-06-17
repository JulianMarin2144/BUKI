import { z } from "zod";

export const TOOL_SCHEMAS = {
  get_user_preferences: z.object({}),
  list_enabled_tools: z.object({}),
  github_list_repos: z.object({
    per_page: z.number().max(30).optional().default(10),
  }),
  github_list_issues: z.object({
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional().default("open"),
  }),
  github_create_issue: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional().default(""),
  }),
  github_create_repo: z.object({
    name: z.string(),
    description: z.string().optional().default(""),
    isPrivate: z.boolean().optional().default(false),
  }),
  read_file: z.object({
    path: z.string().describe("Absolute path or path relative to the server process working directory."),
    offset: z.number().int().min(1).optional().describe("1-based line number to start reading from. Defaults to 1."),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to return starting at offset."),
  }),
  write_file: z.object({
    path: z.string().describe("Absolute path or path relative to the server process working directory. The file must NOT exist yet."),
    content: z.string().max(500_000).describe("Full UTF-8 content to write into the new file."),
  }),
  edit_file: z.object({
    path: z.string().describe("Absolute path or path relative to the server process working directory. The file must already exist."),
    old_string: z.string().describe("Literal substring to find. Must appear exactly once in the file."),
    new_string: z.string().describe("Literal string that replaces the single occurrence of old_string."),
  }),
  buk_list_employees: z.object({
    page: z.number().int().min(1).optional().default(1),
    page_size: z.number().int().min(1).max(30).optional().default(20),
    area: z.string().optional().describe("Filter employees by area or department name (partial match)"),
    name: z.string().optional().describe("Filter employees by name (partial match)"),
  }),
  buk_get_employee: z.object({
    id: z.number().int().describe("Employee ID in BUK"),
  }),
  buk_list_absences: z.object({}),
  buk_list_vacations: z.object({
    employee_id: z.number().int().optional().describe("Optional employee ID to get available vacation days"),
  }),
  buk_list_licenses: z.object({}),
  bash: z.object({
    terminal: z.string().describe("Terminal identifier for correlation and logging"),
    prompt: z.string().max(4096).describe("Bash command to execute"),
  }),
  schedule_task: z
    .object({
      prompt: z.string().min(1).describe("The instruction the agent will run when the task fires."),
      schedule_type: z
        .enum(["one_time", "recurring"])
        .describe("Whether this is a single execution or a recurring one."),
      run_at: z
        .string()
        .optional()
        .describe("ISO 8601 datetime for one_time tasks (e.g. '2026-04-10T09:00:00Z')."),
      cron_expr: z
        .string()
        .optional()
        .describe(
          "5-field cron expression for recurring tasks (e.g. '0 9 * * 1' = every Monday 9 AM)."
        ),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone name (e.g. 'America/Bogota'). Defaults to user timezone."),
    })
    .refine(
      (data) => {
        if (data.schedule_type === "one_time") return !!data.run_at;
        if (data.schedule_type === "recurring") return !!data.cron_expr;
        return false;
      },
      {
        message:
          "one_time tasks require run_at; recurring tasks require cron_expr.",
      }
    ),
} as const;

export type ToolSchemas = typeof TOOL_SCHEMAS;
export type ToolId = keyof ToolSchemas;
