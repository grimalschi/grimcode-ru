import { useNavigate, useParams } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { api, messageOf } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAsync } from '@/hooks/use-async';

type Draft = Omit<Parameters<typeof api.saveDraft.mutate>[0], 'id'>;

export function VersionEditorPage() {
  const { versionId } = useParams({ from: '/versions/$versionId' });
  return <VersionEditor key={versionId} versionId={versionId} />;
}

function VersionEditor({ versionId }: { versionId: string }) {
  const navigate = useNavigate();

  const state = useAsync(() => api.getVersion.query({ id: versionId }), [versionId]);

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Keep unsaved changes when version metadata reloads.
  React.useEffect(() => {
    if (draft || !state.data) return;
    const { subject, source } = state.data.version;
    setDraft({ subject, source });
  }, [draft, state.data]);

  const version = state.data?.version;
  const editable = version?.status === 'draft';

  const save = async (publish = false) => {
    if (!draft) return;
    setBusy(true);
    try {
      await api.saveDraft.mutate({ id: versionId, ...draft });
      if (publish) await api.publishDraft.mutate({ id: versionId });
      toast.success(publish ? 'Опубликовано — новые письма пойдут по этой версии' : 'Черновик сохранён');
      state.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (state.error) {
    return (
      <AdminPage title="Версия">
        <ErrorState error={state.error} retry={state.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title={version ? `Версия ${version.version}` : 'Версия'}
      description={
        version ? (
          <span className="flex items-center gap-2">
            <Badge variant={editable ? 'secondary' : 'outline'}>{version.status}</Badge>
            <span>
              {editable
                ? 'Изменения вступят в силу после публикации.'
                : 'Для изменений создайте новый черновик.'}
            </span>
          </span>
        ) : null
      }
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void navigate({ to: '/' })}>
            Все шаблоны
          </Button>
          {editable && draft ? (
            <>
              <TestSend
                versionId={versionId}
                disabled={busy}
                beforeSend={async () => {
                  await api.saveDraft.mutate({ id: versionId, ...draft });
                }}
              />
              <Button variant="outline" onClick={() => void save()} disabled={busy}>
                Сохранить
              </Button>
              <Button onClick={() => void save(true)} disabled={busy}>
                Опубликовать
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      {!version || !draft ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="subject">Тема</Label>
            <Input
              id="subject"
              value={draft.subject}
              readOnly={!editable}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              {'Переменные пишутся как {{name}} и подставляются при отправке.'}
            </p>
          </div>

          <Tabs defaultValue="edit">
            <TabsList>
              <TabsTrigger value="edit">MJML</TabsTrigger>
              <TabsTrigger value="preview">Предпросмотр</TabsTrigger>
            </TabsList>

            <TabsContent value="preview">
              <VersionPreview versionId={versionId} draft={editable ? draft : undefined} />
            </TabsContent>

            <TabsContent value="edit">
              <div className="space-y-2">
                <Label htmlFor="email-source">Код MJML</Label>
                <textarea
                  id="email-source"
                  value={draft.source}
                  readOnly={!editable}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, source: event.target.value })}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  wrap="off"
                  rows={20}
                  className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 min-h-96 w-full resize-y rounded-md border p-4 font-mono text-sm leading-relaxed shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
                />
              </div>
            </TabsContent>
          </Tabs>

          {version.compiledHtml ? (
            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer text-sm font-medium">
                Текстовая версия
              </summary>
              <pre className="mt-3 max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
                {version.compiledText}
              </pre>
            </details>
          ) : null}
        </>
      )}
    </AdminPage>
  );
}

function VersionPreview({ versionId, draft }: { versionId: string; draft?: Draft }) {
  const state = useAsync(
    () => api.previewVersion.query({ id: versionId, variables: {}, ...(draft ? { draft } : {}) }),
    [versionId, draft],
  );

  if (state.loading) return <Skeleton className="h-96 w-full" />;
  if (state.error) {
    return (
      <p className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
        {messageOf(state.error)}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">
        Тема: <span className="text-foreground">{state.data?.subject}</span>
      </p>
      <iframe
        title="Предпросмотр письма"
        sandbox=""
        srcDoc={state.data?.html ?? ''}
        className="h-96 w-full rounded-lg border bg-white"
      />
      <p className="text-muted-foreground text-xs">
        Переменные показаны как {'{{name}}'} — у каждого получателя будут свои значения.
      </p>
    </div>
  );
}

function TestSend({ versionId, disabled, beforeSend }: {
  versionId: string;
  disabled: boolean;
  beforeSend: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await beforeSend();
      await api.testSend.mutate({ id: versionId, to: to.trim(), variables: {} });
      toast.success('Отправлено — смотрите журнал');
      setOpen(false);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={disabled}>
        Тестовая отправка
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Тестовая отправка</DialogTitle>
          <DialogDescription>
            Это настоящая отправка через настроенный транспорт, и она попадёт в журнал.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="test-to">Кому</Label>
          <Input
            id="test-to"
            type="email"
            value={to}
            disabled={busy}
            onChange={(event) => setTo(event.target.value)}
            placeholder="you@example.com"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy || to.trim() === ''}>
            Отправить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
