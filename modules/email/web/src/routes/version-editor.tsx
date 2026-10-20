import { useNavigate, useParams } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { api, messageOf } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageLoader } from '@/components/layout/page-loader';
import { useAsync } from '@/hooks/use-async';
import { useLate } from '@/hooks/use-late';
import { cn } from '@/lib/utils';
import { VERSION_STATUS_LABEL } from '@/status-labels';

type Draft = Omit<Parameters<typeof api.saveDraft.mutate>[0], 'id'>;

export function VersionEditorPage() {
  const { versionId } = useParams({ from: '/versions/$versionId' });
  // Not remounted per version: switching keeps the page — title, switcher, the previous version dimmed —
  // until the next one arrives, instead of blanking everything to a placeholder and back.
  return <VersionEditor versionId={versionId} />;
}

function VersionEditor({ versionId }: { versionId: string }) {
  const state = useAsync(() => api.getVersion.query({ id: versionId }), [versionId]);

  // Edits belong to the version they were made in. Another version starts from its own saved text, so
  // unsaved edits never travel to it; the same version keeps them when its metadata reloads.
  const [edits, setEdits] = React.useState<(Draft & { for: string }) | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState('edit');
  const late = useLate(!state.data && !state.error);

  // The version on screen: while the next one loads, the previous one stays, dimmed.
  const version = state.data?.version;
  const current = version?.id === versionId;
  // Memoised: the preview asks the server again whenever this object changes, so it may change only
  // with the version or an edit, not with every render.
  const draft: Draft | null = React.useMemo(
    () => (version
      ? edits?.for === version.id ? { subject: edits.subject, source: edits.source } : { subject: version.subject, source: version.source }
      : null),
    [version, edits],
  );
  const setDraft = (next: Draft) => version && setEdits({ ...next, for: version.id });
  const editable = version?.status === 'draft';
  // Unsaved: the form differs from what the draft holds. Leaving for another version would drop it.
  const dirty = Boolean(editable && version && draft && (draft.subject !== version.subject || draft.source !== version.source));

  // The template's versions, for the switcher in the corner and the template's name as the title.
  const navigate = useNavigate();
  const templateId = version?.templateId;
  const template = useAsync(
    () => (templateId ? api.getTemplate.query({ id: templateId }) : Promise.resolve(null)),
    [templateId],
  );
  const templateName = template.data?.template.name;
  const versions = template.data?.versions;
  const [leaving, setLeaving] = React.useState<string | null>(null);
  // The switcher names the version asked for at once, even before its text arrives.
  const chosen = versions?.find((item) => item.id === versionId) ?? version;
  const open = (id: string) => void navigate({ to: '/versions/$versionId', params: { versionId: id } });
  const switchTo = (id: string) => {
    if (id === versionId) return;
    if (dirty) setLeaving(id);
    else open(id);
  };

  const save = async (publish = false) => {
    if (!draft || !current) return;
    setBusy(true);
    try {
      await api.saveDraft.mutate({ id: versionId, ...draft });
      if (publish) await api.publishDraft.mutate({ id: versionId });
      toast.success(publish ? 'Опубликовано — новые письма пойдут по этой версии' : 'Черновик сохранён');
      setEdits(null);
      state.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  // The first open appears whole once the version arrives; a loader only if that takes a while. Switching
  // between versions afterwards keeps the previous one on screen instead.
  if (!version && !state.error) return <PageLoader late={late} />;

  if (state.error) {
    return (
      <AdminPage title="Версия">
        <ErrorState error={state.error} retry={state.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title={templateName ?? (version ? `Версия ${version.version}` : 'Версия')}
      description={
        version
          ? editable
            ? 'Изменения вступят в силу после публикации.'
            : 'Для изменений создайте новый черновик.'
          : null
      }
      actions={
        // The tabs above lead back to the templates; the versions are switched above the subject.
        <div className="flex flex-wrap items-center justify-end gap-2">
          {editable && draft ? (
            <>
              <TestSend
                versionId={versionId}
                disabled={busy || !current}
                beforeSend={async () => {
                  await api.saveDraft.mutate({ id: versionId, ...draft });
                }}
              />
              <Button variant="outline" onClick={() => void save()} disabled={busy || !current}>
                Сохранить
              </Button>
              <Button onClick={() => void save(true)} disabled={busy || !current}>
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
        <div aria-busy={!current} className={cn('flex flex-col gap-6 transition-opacity', !current && 'pointer-events-none opacity-50')}>
          {/* The version and its status, as a switcher between the template's versions. */}
          <div className="space-y-2">
            <Label htmlFor="version">Версия</Label>
            <Select value={versionId} onValueChange={switchTo}>
              <SelectTrigger id="version" className="w-64">
                <SelectValue>{`Версия ${(chosen ?? version).version} · ${VERSION_STATUS_LABEL[(chosen ?? version).status]}`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(versions ?? [version]).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {`Версия ${item.version} · ${VERSION_STATUS_LABEL[item.status]}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="edit">MJML</TabsTrigger>
              <TabsTrigger value="preview">Предпросмотр</TabsTrigger>
              <TabsTrigger value="text">Текст</TabsTrigger>
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

            {/* The same server rendering as the preview: a draft shows the text its current code would produce. */}
            <TabsContent value="text">
              <VersionPreview versionId={versionId} draft={editable ? draft : undefined} show="text" />
            </TabsContent>
          </Tabs>
        </div>
      )}
      <Dialog open={leaving !== null} onOpenChange={(isOpen) => !isOpen && setLeaving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Перейти без сохранения?</DialogTitle>
            <DialogDescription>Несохранённые правки в этом черновике пропадут.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLeaving(null)}>
              Остаться
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const id = leaving;
                setLeaving(null);
                if (id) open(id);
              }}
            >
              Перейти
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}

function VersionPreview({ versionId, draft, show = 'html' }: { versionId: string; draft?: Draft; show?: 'html' | 'text' }) {
  const state = useAsync(
    () => api.previewVersion.query({ id: versionId, variables: {}, ...(draft ? { draft } : {}) }),
    [versionId, draft],
  );

  // A placeholder only before the first preview: afterwards the last one stays, dimmed, until the next.
  if (state.loading && !state.data) return <Skeleton className="h-96 w-full" />;
  if (state.error) {
    return (
      <p className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
        {messageOf(state.error)}
      </p>
    );
  }

  if (show === 'text') {
    return (
      <div className={cn('space-y-2 transition-opacity', state.loading && 'opacity-50')}>
        <p className="text-muted-foreground text-xs">
          Так письмо увидят почтовые программы, которые не показывают оформление.
        </p>
        <pre className="bg-muted max-h-[32rem] overflow-auto rounded-md p-4 text-sm break-words whitespace-pre-wrap">
          {state.data?.text}
        </pre>
      </div>
    );
  }

  return (
    <div className={cn('space-y-2 transition-opacity', state.loading && 'opacity-50')}>
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
