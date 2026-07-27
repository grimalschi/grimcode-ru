import { Editor } from '@maily-to/core';
import { useNavigate, useParams } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import type { editorDocumentSchema } from '@template/contracts';
import type { z } from 'zod';

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

import '@maily-to/core/style.css';

interface Version {
  id: string;
  templateId: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  subject: string;
  editorFormat: string;
  editorDocument: z.infer<typeof editorDocumentSchema>;
  compiledHtml: string | null;
  compiledText: string | null;
}

/**
 * The editor.
 *
 * Maily is self-hosted as part of this service's build and loaded only here — it is not part of
 * the central Admin bundle, and never part of runtime delivery. The document it produces is stored
 * exactly as the editor wrote it, next to the marker of its format.
 *
 * Only a draft is editable. A published version is a record of what was approved, so it is shown
 * read-only; changing it means creating a new draft.
 */
export function VersionEditorPage() {
  const { versionId } = useParams({ from: '/versions/$versionId' });
  const navigate = useNavigate();

  const state = useAsync<{ version: Version }>(() => api.getVersion({ id: versionId }), [versionId]);

  const [subject, setSubject] = React.useState('');
  const [document, setDocument] = React.useState<Version['editorDocument'] | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Filled once, so typing is never overwritten by a later reload.
  React.useEffect(() => {
    if (loaded || !state.data) return;
    setSubject(state.data.version.subject);
    setDocument(state.data.version.editorDocument);
    setLoaded(true);
  }, [loaded, state.data]);

  const version = state.data?.version;
  const editable = version?.status === 'draft';

  const save = async () => {
    if (!document) return;
    setBusy(true);
    try {
      await api.saveDraft({ id: versionId, subject, editorDocument: document });
      toast.success('Черновик сохранён');
      state.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      // Saving first, so what is published is what is on screen rather than the last saved copy.
      if (document) await api.saveDraft({ id: versionId, subject, editorDocument: document });
      await api.publishDraft({ id: versionId });
      toast.success('Опубликовано — новые письма пойдут по этой версии');
      state.reload();
    } catch (error) {
      // The server refuses a document that uses an undeclared variable, and says which one.
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
                ? 'Черновик. Ничего отсюда не отправляется до публикации.'
                : 'Не черновик — показан таким, каким его утвердили. Чтобы изменить, создайте новый черновик.'}
            </span>
          </span>
        ) : null
      }
      actions={
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void navigate({ to: '/' })}>
            Все шаблоны
          </Button>
          {editable ? (
            <>
              <TestSend versionId={versionId} />
              <Button variant="outline" onClick={() => void save()} disabled={busy}>
                Сохранить
              </Button>
              <Button onClick={() => void publish()} disabled={busy}>
                Опубликовать
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      {state.loading || !version ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="subject">Тема</Label>
            <Input
              id="subject"
              value={subject}
              disabled={!editable}
              onChange={(event) => setSubject(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {'Переменные пишутся как {{name}} и подставляются при отправке.'}
            </p>
          </div>

          <Tabs defaultValue="edit">
            <TabsList>
              <TabsTrigger value="edit">{editable ? 'Редактор' : 'Документ'}</TabsTrigger>
              <TabsTrigger value="preview">Предпросмотр</TabsTrigger>
            </TabsList>

            <TabsContent value="preview">
              <VersionPreview versionId={versionId} />
            </TabsContent>

            <TabsContent value="edit">
          {/*
                An email is a light document, and the editor's own stylesheet is written for that:
                dropped into a dark panel its toolbar goes white on white. The canvas is pinned to
                the light theme instead of being fought with overrides — which is also honest, since
                this is what the message will look like.
              */}
          <div className="maily-canvas rounded-lg border bg-white p-4 text-black" data-theme="light">
            <Editor
              key={version.id}
              contentJson={version.editorDocument as never}
              editable={editable}
              onUpdate={(editor) => setDocument(editor.getJSON() as Version['editorDocument'])}
              config={{ hasMenuBar: editable, spellCheck: true, immediatelyRender: false }}
            />
          </div>
            </TabsContent>
          </Tabs>

          {version.compiledHtml ? (
            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer text-sm font-medium">
                Что опубликовано
              </summary>
              <p className="text-muted-foreground mt-2 text-xs">
                Тот самый HTML и текст, сохранённые при публикации. Отправка берёт именно их и никогда
                не пересобирает документ.
              </p>
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

/**
 * The message as a recipient would see it.
 *
 * Rendered by the server from the stored document, so it is the same pipeline publishing uses —
 * the editor's own canvas shows the document, which is not the same thing as the email.
 *
 * Shown in a fully sandboxed frame: no scripts, no access to this origin.
 */
function VersionPreview({ versionId }: { versionId: string }) {
  const state = useAsync<{ subject: string; html: string; text: string }>(
    () => api.previewVersion({ id: versionId, variables: {} }),
    [versionId],
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

function TestSend({ versionId }: { versionId: string }) {
  const [open, setOpen] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      // A test send is a real send: it goes through the transport and lands in the delivery log
      // with exactly the content that left the system.
      await api.testSend({ id: versionId, to: to.trim(), variables: {} });
      toast.success('Отправлено — смотрите журнал');
      setOpen(false);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)}>
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
            onChange={(event) => setTo(event.target.value)}
            placeholder="you@example.com"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
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
