import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decrypt } from "@agents/db";

// Temporary diagnostic endpoint — only active in development
export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("q") ?? "";
  const employeeId = searchParams.get("id");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = createServerClient();
  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("provider", "buk")
    .eq("status", "active")
    .single();

  if (!integrations?.encrypted_tokens) {
    return NextResponse.json({ error: "BUK not connected" }, { status: 400 });
  }

  const config = JSON.parse(decrypt(integrations.encrypted_tokens as string)) as {
    tenant: string; country: string; token: string;
  };

  const base = `${config.tenant}/api/v1/${config.country}`;
  const headers = { auth_token: config.token, Accept: "application/json" };

  // Fetch a specific employee by ID
  if (employeeId) {
    const res = await fetch(`${base}/employees/${employeeId}`, { headers });
    const raw = await res.json();
    return NextResponse.json({ employee_id: employeeId, raw });
  }

  // Search employees by name across all pages
  const normalize = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const words = normalize(search).split(/\s+/).filter(Boolean);
  const matches: unknown[] = [];
  let totalFetched = 0;

  for (let page = 1; page <= 20 && matches.length < 5; page++) {
    const res = await fetch(`${base}/employees?page=${page}&page_size=50`, { headers });
    if (!res.ok) break;
    const data = await res.json();
    const batch: Record<string, unknown>[] = Array.isArray(data) ? data : (data?.data ?? []);
    if (batch.length === 0) break;
    totalFetched += batch.length;

    for (const e of batch) {
      const hay = normalize(String(e.full_name ?? `${e.first_name ?? ""} ${e.surname ?? ""} ${e.second_surname ?? ""}`));
      if (words.every((w) => hay.includes(w))) {
        matches.push(e);
      }
    }
    if (batch.length < 50) break;
  }

  return NextResponse.json({
    query: search,
    total_fetched: totalFetched,
    matches_found: matches.length,
    // Return full raw data of matches so we can inspect all fields
    matches,
  });
}
