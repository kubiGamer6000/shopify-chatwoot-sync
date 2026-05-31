import * as React from 'react';
import {
  ChevronDown,
  Loader2,
  MessageSquareQuote,
  Send,
  Sparkles,
  StickyNote,
  WandSparkles,
} from 'lucide-react';
import type { LastCustomerMessage, ResolvedContext } from '@/lib/types';
import { getDraft, generateDraft, sendReply } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
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
  const [lastMsg, setLastMsg] = React.useState<LastCustomerMessage | null>(null);
  const [showLastMsg, setShowLastMsg] = React.useState(false);
  const [showNote, setShowNote] = React.useState(false);
  const [instruction, setInstruction] = React.useState('');
  const [generating, setGenerating] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    if (!conversationId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setResponse('');
    setNoteToAgent(null);
    setLastMsg(null);
    setShowLastMsg(false);
    setShowNote(false);
    setInstruction('');
    getDraft(conversationId)
      .then((res) => {
        if (!active) return;
        if (res.draft) {
          setResponse(res.draft.response);
          setNoteToAgent(res.draft.noteToAgent);
        }
        setLastMsg(res.lastCustomerMessage);
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

  const canGenerate = !!conversationId && !!contactId && !generating && !sending;
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
      const res = await sendReply(conversationId, response.trim(), true);
      notify(
        'success',
        res.resolved
          ? 'Message sent & conversation resolved.'
          : 'Message sent (could not resolve conversation).',
      );
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
    <Card className="border-info/30 bg-info/5 gap-0 overflow-hidden py-0 shadow-sm">
      {/* Unique accent strip distinguishes the composer from data cards */}
      <div className="from-info via-info to-success h-1 w-full bg-gradient-to-r" />

      <CardContent className="flex flex-col gap-3 px-4 py-4">
        <div className="flex items-center gap-2.5">
          <div className="from-info to-info/70 text-info-foreground flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br shadow-sm">
            <WandSparkles className="size-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold leading-tight">
              Compose reply
            </span>
            <span className="text-muted-foreground text-xs leading-tight">
              AI-assisted · sends to the customer
            </span>
          </div>
        </div>

        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading suggested reply…
          </div>
        ) : (
          <>
            {/* Collapsed-by-default message being replied to */}
            {lastMsg && (
              <div className="border-border/70 bg-muted/30 overflow-hidden rounded-lg border">
                <button
                  type="button"
                  onClick={() => setShowLastMsg((v) => !v)}
                  className="hover:bg-muted/50 flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors"
                >
                  <MessageSquareQuote className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="text-xs font-medium">Customer's last message</span>
                  <span className="text-muted-foreground/70 ml-auto text-[11px]">
                    {formatDateTime(lastMsg.createdAt)}
                  </span>
                  <ChevronDown
                    className={cn(
                      'text-muted-foreground size-3.5 shrink-0 transition-transform',
                      showLastMsg && 'rotate-180',
                    )}
                  />
                </button>
                {showLastMsg && (
                  <p className="text-muted-foreground border-border/60 bg-card/60 max-h-40 overflow-y-auto border-t px-2.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
                    {lastMsg.content}
                  </p>
                )}
              </div>
            )}

            {/* Note to agent — collapsed by default, never sent to the customer */}
            {noteToAgent && (
              <div className="border-warning/40 bg-warning/10 overflow-hidden rounded-lg border">
                <button
                  type="button"
                  onClick={() => setShowNote((v) => !v)}
                  className="hover:bg-warning/15 flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors"
                >
                  <StickyNote className="text-warning-foreground/90 size-3.5 shrink-0" />
                  <span className="text-warning-foreground/90 text-xs font-semibold uppercase tracking-wide">
                    Note to agent
                  </span>
                  <span className="text-warning-foreground/60 text-[11px] font-medium normal-case">
                    not sent
                  </span>
                  <ChevronDown
                    className={cn(
                      'text-warning-foreground/70 ml-auto size-3.5 shrink-0 transition-transform',
                      showNote && 'rotate-180',
                    )}
                  />
                </button>
                {showNote && (
                  <p className="text-foreground/80 border-warning/30 px-2.5 py-2 text-sm leading-relaxed whitespace-pre-wrap border-t">
                    {noteToAgent}
                  </p>
                )}
              </div>
            )}

            <Textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="The latest AI suggestion appears here. Edit it, or give an instruction below to generate one."
              rows={9}
              className="resize-y bg-card leading-relaxed"
              disabled={generating || sending}
            />

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
                  'border-input bg-card placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50',
                  'h-9 w-full flex-1 rounded-md border px-3 text-sm shadow-xs outline-none',
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
              className="w-full"
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Send message &amp; resolve
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
