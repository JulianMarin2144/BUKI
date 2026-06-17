import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, encrypt, upsertIntegration } from "@agents/db";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { tenant, country, token } = body ?? {};

  if (!tenant || !country || !token) {
    return NextResponse.json(
      { error: "tenant, country y token son requeridos" },
      { status: 400 }
    );
  }

  const tenantUrl = tenant.trim().replace(/\/$/, "");
  const countrySlug = country.trim().toLowerCase();

  // Verify the token works before saving
  try {
    const testRes = await fetch(
      `${tenantUrl}/api/v1/${countrySlug}/employees?page_size=1`,
      { headers: { auth_token: token, Accept: "application/json" } }
    );
    if (!testRes.ok) {
      return NextResponse.json(
        { error: "El token no es válido o no tiene permisos de lectura en BUK" },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "No se pudo conectar con la URL de BUK. Verifica el tenant." },
      { status: 400 }
    );
  }

  const payload = JSON.stringify({ tenant: tenantUrl, country: countrySlug, token });
  const encryptedTokens = encrypt(payload);

  const db = createServerClient();
  await upsertIntegration(db, user.id, "buk", ["read"], encryptedTokens);

  return NextResponse.json({ ok: true });
}
