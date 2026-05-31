import * as React from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToastMessage {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

interface ToastContextValue {
  notify: (kind: ToastMessage['kind'], text: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);

  const notify = React.useCallback(
    (kind: ToastMessage['kind'], text: string) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, kind, text }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="pointer-events-none fixed bottom-3 left-1/2 z-[100] flex w-[calc(100%-1.5rem)] max-w-sm -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg',
              'animate-in slide-in-from-bottom-2 fade-in-0',
              t.kind === 'success'
                ? 'bg-success text-success-foreground border-transparent'
                : 'bg-destructive text-destructive-foreground border-transparent',
            )}
          >
            {t.kind === 'success' ? (
              <CheckCircle2 className="size-4 shrink-0" />
            ) : (
              <XCircle className="size-4 shrink-0" />
            )}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
