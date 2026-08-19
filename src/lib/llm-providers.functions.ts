import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type { LlmProviderKindPublic } from "./llm-catalog";
import type { LlmProviderKindPublic } from "./llm-catalog";

export type LlmProviderPublic = {
  id: string;
  provider: LlmProviderKindPublic;
  label: string;
  hasKey: boolean;
  baseUrl?: string;
  defaultModel?: string;
  isDefault: boolean;
  createdAt: number;
};

type Row = {
  id: string;
  workspace_id: string;
  provider: string;
  label: string;
  api_key: string | null;
  api_key_enc: string | null;
  base_url: string | null;
  default_model: string | null;
  is_default: boolean;
  created_at: string;
};

const toPublic = (r: Row): LlmProviderPublic => ({
  id: r.id,
  provider: r.provider as LlmProviderKindPublic,
  label: r.label,
  hasKey: !!(r.api_key || r.api_key_enc),
  baseUrl: r.base_url ?? undefined,
  defaultModel: r.default_model ?? undefined,
  isDefault: r.is_default,
  createdAt: new Date(r.created_at).getTime(),
});

const ProviderEnum = z.enum(["openai", "anthropic", "google", "azure"]);

export const listLlmProviders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ providers: LlmProviderPublic[] }> => {
    const supabase = context.supabase as any;
    const { data: rows, error } = await supabase
      .from("llm_providers")
      .select("*")
      .eq("workspace_id", data.workspaceId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { providers: ((rows ?? []) as Row[]).map(toPublic) };
  });

export const saveLlmProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        provider: ProviderEnum,
        label: z.string().min(1).max(100),
        apiKey: z.string().min(8).max(500),
        baseUrl: z.string().url().optional().or(z.literal("")),
        defaultModel: z.string().max(120).optional().or(z.literal("")),
        makeDefault: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<LlmProviderPublic> => {
    const supabase = context.supabase as any;
    const { writeProviderKey } = await import("./crypto.server");

    const { count } = await supabase
      .from("llm_providers")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", data.workspaceId);
    const shouldDefault = data.makeDefault || !count;

    if (shouldDefault) {
      await supabase
        .from("llm_providers")
        .update({ is_default: false })
        .eq("workspace_id", data.workspaceId);
    }

    const keyCols = await writeProviderKey(data.apiKey);
    const { data: row, error } = await supabase
      .from("llm_providers")
      .insert({
        workspace_id: data.workspaceId,
        provider: data.provider,
        label: data.label,
        ...keyCols,
        base_url: data.baseUrl || null,
        default_model: data.defaultModel || null,
        is_default: shouldDefault,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return toPublic(row as Row);
  });

export const setDefaultLlmProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const supabase = context.supabase as any;
    await supabase
      .from("llm_providers")
      .update({ is_default: false })
      .eq("workspace_id", data.workspaceId);
    const { error } = await supabase
      .from("llm_providers")
      .update({ is_default: true })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteLlmProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { error } = await (context.supabase as any)
      .from("llm_providers")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testLlmProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: boolean; error?: string; reply?: string }> => {
    const supabase = context.supabase as any;
    const { data: row, error } = await supabase
      .from("llm_providers")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error || !row) return { ok: false, error: "Provider not found." };
    try {
      const { resolveChatModel } = await import("./llm-resolver.server");
      const { generateText } = await import("ai");
      const { model } = await resolveChatModel(supabase, row.workspace_id);
      const { text } = await generateText({
        model,
        prompt: "Reply with the single word: ok",
        maxOutputTokens: 20,
      });
      return { ok: true, reply: text.trim().slice(0, 40) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return { ok: false, error: msg.slice(0, 200) };
    }
  });
