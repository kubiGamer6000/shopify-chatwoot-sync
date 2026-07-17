import { useEffect, useMemo, useState } from 'react';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { fetchConfig, fetchConfigHistory, saveConfig } from '@/lib/api';
import type {
  AiConfig,
  AiConfigKey,
  AiConfigOverrides,
  ConfigVersion,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface FieldDef {
  key: AiConfigKey;
  label: string;
  help?: string;
}

const PROMPT_FIELDS: FieldDef[] = [
  { key: 'draftSystemPrompt', label: 'Draft generator', help: 'System prompt for AI reply drafts (private notes + composer).' },
  { key: 'responderSystemPrompt', label: 'AgentBot responder', help: 'System prompt for the autonomous responder agent.' },
  { key: 'classifierSystemPrompt', label: 'Classifier', help: 'Assigns conversation labels that drive routing.' },
  { key: 'summarySystemPrompt', label: 'Customer summary', help: 'Builds the customer 360 AI summary.' },
  { key: 'resolverSystemPromptTemplate', label: 'Shopify matcher', help: 'Uses {{email}} placeholder. Locates unmatched customers.' },
  { key: 'holdingSystemPrompt', label: 'Holding reply', help: 'Short holding message sent on hard escalation.' },
];

const MODEL_FIELDS: FieldDef[] = [
  { key: 'draftModel', label: 'Draft model' },
  { key: 'responderModel', label: 'Responder model' },
  { key: 'classifierModel', label: 'Classifier model' },
  { key: 'summaryModel', label: 'Summary model' },
  { key: 'resolverModel', label: 'Matcher model' },
  { key: 'holdingModel', label: 'Holding-reply model' },
];

const NUMERIC_FIELDS: FieldDef[] = [
  { key: 'draftMaxTokens', label: 'Draft max tokens' },
  { key: 'classifierMaxTokens', label: 'Classifier max tokens' },
  { key: 'summaryMaxTokens', label: 'Summary max tokens' },
  { key: 'holdingMaxTokens', label: 'Holding max tokens' },
  { key: 'responderMaxTokens', label: 'Responder max tokens' },
  { key: 'responderMaxIterations', label: 'Responder max iterations' },
  { key: 'resolverMaxTokens', label: 'Matcher max tokens' },
  { key: 'resolverMaxIterations', label: 'Matcher max iterations' },
];

export function SettingsPage() {
  const [defaults, setDefaults] = useState<AiConfig | null>(null);
  const [values, setValues] = useState<AiConfig | null>(null);
  const [overrideKeys, setOverrideKeys] = useState<Set<AiConfigKey>>(new Set());
  const [meta, setMeta] = useState<{ updatedBy: string | null; updatedAt: string | null }>({
    updatedBy: null,
    updatedAt: null,
  });
  const [history, setHistory] = useState<ConfigVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [cfg, hist] = await Promise.all([fetchConfig(), fetchConfigHistory()]);
      setDefaults(cfg.defaults);
      setValues(cfg.effective);
      setOverrideKeys(new Set(Object.keys(cfg.overrides) as AiConfigKey[]));
      setMeta(cfg.meta);
      setHistory(hist.history);
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Mirror the current unsaved overrides to localStorage so the Prompt Tester
  // can optionally replay with changes that haven't been saved yet.
  useEffect(() => {
    if (!values) return;
    const overrides: AiConfigOverrides = {};
    for (const key of overrideKeys) (overrides[key] as unknown) = values[key];
    try {
      localStorage.setItem('admin.unsavedOverrides', JSON.stringify(overrides));
    } catch {
      // ignore storage failures
    }
  }, [values, overrideKeys]);

  function setField<K extends AiConfigKey>(key: K, value: AiConfig[K]) {
    setValues((prev) => (prev ? { ...prev, [key]: value } : prev));
    setOverrideKeys((prev) => new Set(prev).add(key));
    setStatus(null);
  }

  function resetField(key: AiConfigKey) {
    if (!defaults) return;
    setValues((prev) => (prev ? { ...prev, [key]: defaults[key] } : prev));
    setOverrideKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setStatus(null);
  }

  const overrideCount = overrideKeys.size;

  async function handleSave() {
    if (!values) return;
    setSaving(true);
    setStatus(null);
    try {
      const overrides: AiConfigOverrides = {};
      for (const key of overrideKeys) {
        (overrides[key] as unknown) = values[key];
      }
      await saveConfig(overrides);
      setStatus({ kind: 'ok', text: 'Configuration saved.' });
      await load();
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  if (loading || !values || !defaults) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">AI Settings</h1>
          <p className="text-muted-foreground text-sm">
            Overrides are stored in Firestore and applied without a redeploy.
            Fields left as default fall back to the shipped values.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {status ? (
            <span
              className={
                status.kind === 'ok' ? 'text-sm text-emerald-600' : 'text-destructive text-sm'
              }
            >
              {status.text}
            </span>
          ) : null}
          <Badge variant={overrideCount > 0 ? 'info' : 'secondary'}>
            {overrideCount} override{overrideCount === 1 ? '' : 's'}
          </Badge>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save
          </Button>
        </div>
      </div>

      <Tabs defaultValue="prompts">
        <TabsList>
          <TabsTrigger value="prompts">Prompts</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="routing">Routing</TabsTrigger>
          <TabsTrigger value="limits">Limits</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="prompts" className="mt-4 flex flex-col gap-4">
          {PROMPT_FIELDS.map((f) => (
            <PromptField
              key={f.key}
              def={f}
              value={String(values[f.key] ?? '')}
              overridden={overrideKeys.has(f.key)}
              onChange={(v) => setField(f.key, v as never)}
              onReset={() => resetField(f.key)}
            />
          ))}
        </TabsContent>

        <TabsContent value="models" className="mt-4">
          <Card>
            <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
              {MODEL_FIELDS.map((f) => (
                <TextField
                  key={f.key}
                  def={f}
                  value={String(values[f.key] ?? '')}
                  overridden={overrideKeys.has(f.key)}
                  onChange={(v) => setField(f.key, v as never)}
                  onReset={() => resetField(f.key)}
                />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="routing" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Routing & behaviour</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <ListField
                label="Auto-respond labels (live)"
                help="Conversations whose labels are all in this set are handled by the responder; anything else escalates."
                value={values.autoRespondLabels}
                overridden={overrideKeys.has('autoRespondLabels')}
                onChange={(v) => setField('autoRespondLabels', v)}
                onReset={() => resetField('autoRespondLabels')}
              />
              <ListField
                label="Backfill auto-respond labels"
                help="Stricter set used by the one-time backfill script."
                value={values.backfillAutoRespondLabels}
                overridden={overrideKeys.has('backfillAutoRespondLabels')}
                onChange={(v) => setField('backfillAutoRespondLabels', v)}
                onReset={() => resetField('backfillAutoRespondLabels')}
              />
              <Separator />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label>Holding reply on escalation</Label>
                  <p className="text-muted-foreground text-sm">
                    When on, a short holding message is sent before handing off to a human.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {overrideKeys.has('holdingReplyEnabled') ? (
                    <Badge variant="info">Override</Badge>
                  ) : (
                    <Badge variant="secondary">Default</Badge>
                  )}
                  <Switch
                    checked={values.holdingReplyEnabled}
                    onCheckedChange={(v) => setField('holdingReplyEnabled', v)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="limits" className="mt-4">
          <Card>
            <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
              {NUMERIC_FIELDS.map((f) => (
                <NumberField
                  key={f.key}
                  def={f}
                  value={Number(values[f.key] ?? 0)}
                  overridden={overrideKeys.has(f.key)}
                  onChange={(v) => setField(f.key, v as never)}
                  onReset={() => resetField(f.key)}
                />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <HistoryView history={history} meta={meta} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OverrideBadge({ overridden }: { overridden: boolean }) {
  return overridden ? (
    <Badge variant="info">Override</Badge>
  ) : (
    <Badge variant="secondary">Default</Badge>
  );
}

function ResetButton({ overridden, onReset }: { overridden: boolean; onReset: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!overridden}
      onClick={onReset}
      title="Reset to default"
    >
      <RotateCcw className="size-3.5" />
      Reset
    </Button>
  );
}

function PromptField(props: {
  def: FieldDef;
  value: string;
  overridden: boolean;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  const { def, value, overridden, onChange, onReset } = props;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">{def.label}</CardTitle>
            {def.help ? (
              <p className="text-muted-foreground mt-1 text-sm">{def.help}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <OverrideBadge overridden={overridden} />
            <ResetButton overridden={overridden} onReset={onReset} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Textarea
          className="min-h-40 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </CardContent>
    </Card>
  );
}

function TextField(props: {
  def: FieldDef;
  value: string;
  overridden: boolean;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  const { def, value, overridden, onChange, onReset } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{def.label}</Label>
        <div className="flex items-center gap-1">
          <OverrideBadge overridden={overridden} />
          <ResetButton overridden={overridden} onReset={onReset} />
        </div>
      </div>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function NumberField(props: {
  def: FieldDef;
  value: number;
  overridden: boolean;
  onChange: (v: number) => void;
  onReset: () => void;
}) {
  const { def, value, overridden, onChange, onReset } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{def.label}</Label>
        <div className="flex items-center gap-1">
          <OverrideBadge overridden={overridden} />
          <ResetButton overridden={overridden} onReset={onReset} />
        </div>
      </div>
      <Input
        type="number"
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function ListField(props: {
  label: string;
  help?: string;
  value: string[];
  overridden: boolean;
  onChange: (v: string[]) => void;
  onReset: () => void;
}) {
  const { label, help, value, overridden, onChange, onReset } = props;
  const [text, setText] = useState(value.join(', '));
  useEffect(() => {
    setText(value.join(', '));
  }, [value]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Label>{label}</Label>
          {help ? <p className="text-muted-foreground mt-1 text-sm">{help}</p> : null}
        </div>
        <div className="flex items-center gap-1">
          <OverrideBadge overridden={overridden} />
          <ResetButton overridden={overridden} onReset={onReset} />
        </div>
      </div>
      <Input
        value={text}
        placeholder="comma, separated, labels"
        onChange={(e) => setText(e.target.value)}
        onBlur={() =>
          onChange(
            text
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
      <div className="flex flex-wrap gap-1">
        {value.map((l) => (
          <Badge key={l} variant="outline">
            {l}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function HistoryView({
  history,
  meta,
}: {
  history: ConfigVersion[];
  meta: { updatedBy: string | null; updatedAt: string | null };
}) {
  const current = useMemo(
    () =>
      meta.updatedAt
        ? `Last saved ${new Date(meta.updatedAt).toLocaleString()} by ${meta.updatedBy ?? 'unknown'}`
        : 'No overrides saved yet — running on shipped defaults.',
    [meta],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Change history</CardTitle>
        <p className="text-muted-foreground text-sm">{current}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {history.length === 0 ? (
          <p className="text-muted-foreground text-sm">No previous versions.</p>
        ) : (
          history.map((v, i) => (
            <div key={i} className="rounded-md border p-3 text-sm">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">
                  {v.updatedAt ? new Date(v.updatedAt).toLocaleString() : 'Unknown date'}
                </span>
                <span className="text-muted-foreground">{v.updatedBy ?? 'unknown'}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {Object.keys(v.config).map((k) => (
                  <Badge key={k} variant="outline">
                    {k}
                  </Badge>
                ))}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
