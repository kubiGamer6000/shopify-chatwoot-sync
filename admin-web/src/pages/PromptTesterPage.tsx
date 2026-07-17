import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { runReplay } from '@/lib/api';
import type { AiConfigOverrides, ReplayKind, ReplayResult } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const KINDS: { value: ReplayKind; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'classifier', label: 'Classifier' },
  { value: 'responder', label: 'Responder' },
];

function readUnsavedOverrides(): AiConfigOverrides | undefined {
  try {
    const raw = localStorage.getItem('admin.unsavedOverrides');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as AiConfigOverrides;
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function PromptTesterPage() {
  const [conversationId, setConversationId] = useState('');
  const [kind, setKind] = useState<ReplayKind>('draft');
  const [escalation, setEscalation] = useState(false);
  const [useUnsaved, setUseUnsaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);

  async function handleRun() {
    const id = Number(conversationId);
    if (!id || Number.isNaN(id)) {
      setError('Enter a valid Chatwoot conversation ID.');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await runReplay({
        conversationId: id,
        kind,
        escalation: kind === 'draft' ? escalation : undefined,
        overrides: useUnsaved ? readUnsavedOverrides() : undefined,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Prompt Tester</h1>
        <p className="text-muted-foreground text-sm">
          Reproduce generation for a real conversation exactly as the system
          would — with no private notes, drafts, labels, or replies written.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Conversation ID</Label>
              <Input
                className="w-48"
                placeholder="e.g. 5793"
                value={conversationId}
                inputMode="numeric"
                onChange={(e) => setConversationId(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Generation</Label>
              <Tabs value={kind} onValueChange={(v) => setKind(v as ReplayKind)}>
                <TabsList>
                  {KINDS.map((k) => (
                    <TabsTrigger key={k.value} value={k.value}>
                      {k.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            <Button onClick={() => void handleRun()} disabled={running}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Run
            </Button>
          </div>

          <div className="flex flex-wrap gap-6">
            {kind === 'draft' ? (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={escalation} onCheckedChange={setEscalation} />
                Escalation variant
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={useUnsaved} onCheckedChange={setUseUnsaved} />
              Apply unsaved Settings changes
            </label>
          </div>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </CardContent>
      </Card>

      {result ? <ResultView result={result} /> : null}
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="bg-muted max-h-[32rem] overflow-auto rounded-md p-4 text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function ResultView({ result }: { result: ReplayResult }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Result</CardTitle>
          <Badge variant="secondary">{result.kind}</Badge>
          <Badge variant="outline">model: {result.model}</Badge>
          {result.contactId ? (
            <Badge variant="outline">contact: {result.contactId}</Badge>
          ) : null}
          {result.email ? <Badge variant="outline">{result.email}</Badge> : null}
          {result.images.length > 0 ? (
            <Badge variant="info">{result.images.length} image(s)</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="output">
          <TabsList>
            <TabsTrigger value="output">Output</TabsTrigger>
            <TabsTrigger value="context">Context</TabsTrigger>
            <TabsTrigger value="system">System Prompt</TabsTrigger>
            <TabsTrigger value="user">User Prompt</TabsTrigger>
            {result.images.length > 0 ? (
              <TabsTrigger value="images">Images</TabsTrigger>
            ) : null}
          </TabsList>

          <TabsContent value="output" className="mt-3">
            <OutputView result={result} />
          </TabsContent>
          <TabsContent value="context" className="mt-3">
            <Pre>{JSON.stringify(result.context, null, 2)}</Pre>
          </TabsContent>
          <TabsContent value="system" className="mt-3">
            <Pre>{result.systemPrompt}</Pre>
          </TabsContent>
          <TabsContent value="user" className="mt-3">
            <Pre>{result.userPrompt}</Pre>
          </TabsContent>
          {result.images.length > 0 ? (
            <TabsContent value="images" className="mt-3">
              <div className="flex flex-wrap gap-3">
                {result.images.map((img, i) => (
                  <figure key={i} className="flex flex-col gap-1">
                    <img
                      src={img.dataUrl}
                      alt={`attachment ${i + 1}`}
                      className="max-h-64 rounded-md border"
                    />
                    <figcaption className="text-muted-foreground text-xs">
                      {img.mediaType} · {(img.bytes / 1024).toFixed(0)} KB
                    </figcaption>
                  </figure>
                ))}
              </div>
            </TabsContent>
          ) : null}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {title}
      </span>
      <div className="rounded-md border p-3 text-sm whitespace-pre-wrap">{body}</div>
    </div>
  );
}

function OutputView({ result }: { result: ReplayResult }) {
  const out = result.output as Record<string, unknown>;

  if (result.kind === 'draft') {
    return (
      <div className="flex flex-col gap-3">
        {out.customerMessageTranslation ? (
          <Section
            title="Customer message (translated)"
            body={String(out.customerMessageTranslation)}
          />
        ) : null}
        <Section title="Response" body={String(out.response ?? '(no response)')} />
        {out.noteToAgent ? (
          <Section title="Note to agent" body={String(out.noteToAgent)} />
        ) : null}
      </div>
    );
  }

  if (result.kind === 'classifier') {
    const labels = (out.labels as string[] | null) ?? [];
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Labels
          </span>
          <div className="flex flex-wrap gap-1">
            {labels.length > 0 ? (
              labels.map((l) => <Badge key={l}>{l}</Badge>)
            ) : (
              <span className="text-muted-foreground text-sm">(none)</span>
            )}
          </div>
        </div>
        <Section title="Reasoning" body={String(out.reasoning ?? '(none)')} />
      </div>
    );
  }

  // responder
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Routing
        </span>
        <Badge variant={out.routingDecision === 'would-respond' ? 'success' : 'warning'}>
          {String(out.routingDecision)}
        </Badge>
      </div>
      <Section title="Candidate reply" body={String(out.text || '(no direct reply — agent used a tool)')} />
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Tool activity
        </span>
        <Pre>{JSON.stringify(out.toolInvocations ?? [], null, 2)}</Pre>
      </div>
    </div>
  );
}
