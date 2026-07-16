import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import SEED from "./seed-data.mts";

const MAX_BACKUPS = 30;

function store() {
  return getStore("gestion-managers");
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    if (path === "/api/data") {
      const s = store();
      if (method === "GET") {
        let state = await s.get("state", { type: "json" });
        if (!state) {
          state = SEED;
          await s.setJSON("state", state);
        }
        return json(state);
      }
      if (method === "POST") {
        const body = await req.json();
        if (!body || !Array.isArray(body.managers) || !Array.isArray(body.clients)) {
          return json({ error: "invalid_body" }, 400);
        }
        await s.setJSON("state", body);
        return json({ ok: true });
      }
    }

    if (path === "/api/backups") {
      const s = store();
      if (method === "GET") {
        const idx = (await s.get("backup-index", { type: "json" })) || [];
        return json(idx);
      }
      if (method === "POST") {
        const body = await req.json().catch(() => ({}));
        const state = await s.get("state", { type: "json" });
        if (!state) return json({ error: "no_data" }, 400);
        const stamp = new Date().toISOString();
        const id = "backup:" + stamp;
        await s.setJSON(id, state);
        let idx: any[] = (await s.get("backup-index", { type: "json" })) || [];
        idx.unshift({
          id,
          stamp,
          manual: !!body.manual,
          count: (state.clients || []).length,
        });
        while (idx.length > MAX_BACKUPS) {
          const old = idx.pop();
          await s.delete(old.id);
        }
        await s.setJSON("backup-index", idx);
        return json({ ok: true, id });
      }
    }

    if (path === "/api/backups/restore" && method === "POST") {
      const s = store();
      const { id } = await req.json();
      if (!id) return json({ error: "missing_id" }, 400);
      const backupData = await s.get(id, { type: "json" });
      if (!backupData) return json({ error: "not_found" }, 404);
      await s.setJSON("state", backupData);
      return json(backupData);
    }

    if (path === "/api/parse" && method === "POST") {
      const { text } = await req.json();
      if (!text || !text.trim()) return json({ error: "empty_text" }, 400);

      const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) {
        return json(
          { error: "missing_api_key", message: "Falta configurar ANTHROPIC_API_KEY en las variables de entorno del sitio." },
          500
        );
      }

      const systemPrompt =
        'Extraes datos de clientes de texto en español (mensajes de WhatsApp, listas de citas, etc). Responde UNICAMENTE con un array JSON valido, sin texto adicional, sin markdown, sin backticks. Cada elemento debe tener EXACTAMENTE estos campos (usa "" si no hay dato): nombre, telefono, direccion, fechaCita, idioma, notas. "idioma" es el idioma preferido del cliente si se menciona. "fechaCita" es la fecha/hora de la cita tal como aparece en el texto. "notas" son observaciones adicionales relevantes. Puede haber uno o varios clientes en el texto.';

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 2000,
          system: systemPrompt,
          messages: [{ role: "user", content: text }],
        }),
      });

      if (!r.ok) {
        const errText = await r.text();
        return json({ error: "anthropic_api_error", status: r.status, detail: errText.slice(0, 500) }, 502);
      }

      const data = await r.json();
      const textBlocks = (data.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      const clean = textBlocks.replace(/```json|```/g, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch (e) {
        return json({ error: "parse_failed", raw: textBlocks.slice(0, 500) }, 500);
      }
      return json(Array.isArray(parsed) ? parsed : [parsed]);
    }

    return json({ error: "not_found" }, 404);
  } catch (e: any) {
    return json({ error: "server_error", message: e.message }, 500);
  }
};

export const config: Config = {
  path: ["/api/data", "/api/backups", "/api/backups/restore", "/api/parse"],
};
