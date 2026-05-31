import * as React from 'react';
import { Loader2, Send, Sparkles, StickyNote } from 'lucide-react';
import type { ResolvedContext } from '@/lib/types';
import { getDraft, generateDraft, sendReply } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/Toast';

export function ResponseComposer({ context }: { context: ResolvedContext }) {
  const { notify } = useToast();
  const conversationId = context.conversationId;
  const contactId = context.contactId;

  const [loading, setLoading] = React.useState(true);
  const [response, setResponse] = React.useState('');
  const [noteToAgent, setNoteToAgent] = React.useState<string | null>(null);
  const [instruction, setInstruction] = React.useState('');
  const [generating, setGenerating] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  // Load the latest stored draft for this conversation (prefilled suggestion).
  React.useEffect(() => {
    if (!conversationId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setResponse('');
    setNoteToAgent(null);
    setInstruction('');
    getDraft(conversationId)
      .then((res) => {
        if (!active) return;
        if (res.draft) {
          setResponse(res.draft.response);
          setNoteToAgent(res.draft.noteToAgent);
        }
      })
      .catch(() => {
        /* no stored draft / firestore disabled — start blank */
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [conversationId]);

  const canGenerate =
    !!conversationId && !!contactId && !generating && !sending;
  const hasResponse = response.trim().length > 0;

  const handleGenerate = async () => {
    if (!conversationId || !contactId) return;
    const isRevision = hasResponse && instruction.trim().length > 0;
    setGenerating(true);
    try {
      const res = await generateDraft({
        conversationId,
        contactId,
        email: context.email,
        ...(isRevision
          ? { previousResponse: response, correction: instruction }
          : { instruction: instruction.trim() || null }),
      });
      setResponse(res.response);
      setNoteToAgent(res.noteToAgent ?? null);
      setInstruction('');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to generate');
    } finally {
      setGenerating(false);
    }
  };

  const handleSend = async () => {
    if (!conversationId || !response.trim()) return;
    setSending(true);
    try {
      await sendReply(conversationId, response.trim());
      notify('success', 'Message sent to customer.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const onInstructionKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && canGenerate) {
      e.preventDefault();
      handleGenerate();
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-3">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="text-info size-4" />
          Response
        </div>

        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading suggested response…
          </div>
        ) : (
          <>
            <Textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="The latest AI suggestion appears here. Edit it, or give an instruction below to generate one."
              rows={9}
              className="resize-y leading-relaxed"
              disabled={generating || sending}
            />

            {noteToAgent && (
              <div className="bg-muted/50 border-border flex flex-col gap-1 rounded-md border p-2.5">
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
                  <StickyNote className="size-3.5" />
                  Note to agent · not sent
                </span>
                <p className="text-foreground/80 text-sm leading-relaxed whitespace-pre-wrap">
                  {noteToAgent}
                </p>
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={onInstructionKeyDown}
                placeholder={
                  hasResponse
                    ? "Tweak it, e.g. 'don't mention a refund, just offer one'"
                    : "Instruction, e.g. 'apologize for the delay and offer a partial refund'"
                }
                disabled={!canGenerate}
                className={cn(
                  'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50',
                  'h-9 w-full flex-1 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none',
                  'transition-[color,box-shadow] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
                )}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerate}
                disabled={!canGenerate}
                title={!contactId ? 'No linked contact' : undefined}
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {hasResponse ? 'Regenerate' : 'Generate'}
              </Button>
            </div>

            <Button
              onClick={handleSend}
              disabled={!hasResponse || sending || generating || !conversationId}
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Send message
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
