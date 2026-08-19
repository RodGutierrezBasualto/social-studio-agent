import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  listServiceCredentials,
  saveServiceCredential,
  deleteServiceCredential,
  testServiceCredential,
  type ServiceCredentialPublic,
  type ServiceNamePublic,
} from "@/lib/service-credentials.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { SectionDisclosure } from "@/components/section-disclosure";
import { Loader2, Plus, Trash2, Radar, CheckCircle2 } from "lucide-react";

const OPTIONS: {
  value: ServiceNamePublic;
  label: string;
  hint: string;
  keyHelp: string;
}[] = [
  {
    value: "firecrawl",
    label: "Firecrawl",
    hint: "Powers web search in chat and website scraping for competitor and brand research.",
    keyHelp: "firecrawl.dev → Dashboard → API keys",
  },
  {
    value: "scrapecreators",
    label: "ScrapeCreators",
    hint: "Powers deep social scans (Instagram, TikTok, X, LinkedIn) for your own handles and competitors.",
    keyHelp: "scrapecreators.com → Dashboard → API key",
  },
];

const empty = { service: "firecrawl" as ServiceNamePublic, label: "", apiKey: "" };

export function ServiceCredentialsSection({ workspaceId }: { workspaceId: string | null }) {
  const list = useServerFn(listServiceCredentials);
  const save = useServerFn(saveServiceCredential);
  const remove = useServerFn(deleteServiceCredential);
  const test = useServerFn(testServiceCredential);

  const [creds, setCreds] = useState<ServiceCredentialPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [form, setForm] = useState(empty);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    list({ data: { workspaceId } })
      .then((r) => setCreds(r.credentials))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId, list]);

  const opt = OPTIONS.find((o) => o.value === form.service)!;

  const onAdd = async () => {
    if (!workspaceId) return;
    setSaving(true);
    try {
      const c = await save({
        data: {
          workspaceId,
          service: form.service,
          label: form.label.trim() || opt.label,
          apiKey: form.apiKey.trim(),
        },
      });
      setCreds((cur) => [c, ...cur.filter((x) => x.service !== c.service)]);
      setForm(empty);
      toast.success(`${opt.label} connected`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const onTest = async (service: ServiceNamePublic) => {
    if (!workspaceId) return;
    setTesting(service);
    try {
      const r = await test({ data: { workspaceId, service } });
      if (r.ok) toast.success("Key works.");
      else toast.error(r.error ?? "Test failed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTesting(null);
    }
  };

  return (
    <SectionDisclosure
      icon={<Radar className="h-4 w-4" />}
      title="Data services (research & scanning)"
      subtitle="Bring your own key"
    >
      <div className="px-5 py-5 space-y-5">
        <p className="text-sm text-muted-foreground">
          Web search, website scraping and social scans run on these services. Connect your own keys
          so usage bills to your account instead of a shared quota. Keys are encrypted at rest.
        </p>

        {loading ? (
          <p className="text-xs text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading
          </p>
        ) : creds.length > 0 ? (
          <ul className="divide-y divide-border border border-border">
            {creds.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{c.label}</p>
                  <p className="text-[11px] text-muted-foreground font-mono truncate">
                    {c.service} · key saved
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    disabled={testing === c.service}
                    onClick={() => onTest(c.service)}
                  >
                    {testing === c.service ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Remove"
                    onClick={async () => {
                      await remove({ data: { id: c.id } });
                      setCreds((cur) => cur.filter((x) => x.id !== c.id));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground border border-dashed border-border px-4 py-3">
            No data service connected yet. Research and social scans fall back to the shared quota,
            which may be unavailable.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 border-t border-border pt-5">
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Service</Label>
            <Select
              value={form.service}
              onValueChange={(v) => setForm((c) => ({ ...c, service: v as ServiceNamePublic }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{opt.hint}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Label</Label>
            <Input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder={opt.label}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">API key</Label>
            <Input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="Paste key"
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">{opt.keyHelp}</p>
          </div>
        </div>

        <Button
          onClick={onAdd}
          disabled={saving || !workspaceId || !form.apiKey.trim()}
          className="gap-2"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{" "}
          Connect service
        </Button>
      </div>
    </SectionDisclosure>
  );
}
