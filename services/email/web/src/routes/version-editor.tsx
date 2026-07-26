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
  locale: string;
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
      toast.success('Draft saved');
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
      toast.success('Published — new messages will use this version');
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
      <AdminPage title="Version">
        <ErrorState error={state.error} retry={state.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title={version ? `${version.locale} · v${version.version}` : 'Version'}
      description={
        version ? (
          <span className="flex items-center gap-2">
            <Badge variant={editable ? 'secondary' : 'outline'}>{version.status}</Badge>
            <span>
              {editable
                ? 'A draft. Nothing here is sent until it is published.'
                : 'Not a draft — shown as it was approved. Create a new draft to change it.'}
            </span>
          </span>
        ) : null
      }
      actions={
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void navigate({ to: '/' })}>
            All templates
          </Button>
          {editable ? (
            <>
              <TestSend versionId={versionId} />
              <Button variant="outline" onClick={() => void save()} disabled={busy}>
                Save
              </Button>
              <Button onClick={() => void publish()} disabled={busy}>
                Publish
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
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              disabled={!editable}
              onChange={(event) => setSubject(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {'Variables are written as {{name}} and filled in when the message is sent.'}
            </p>
          </div>

          <Tabs defaultValue="edit">
            <TabsList>
              <TabsTrigger value="edit">{editable ? 'Edit' : 'Document'}</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>

            <TabsContent value="preview">
              <VersionPreview versionId={versionId} />
            </TabsContent>

            <TabsContent value="edit">
          <div className="rounded-lg border p-4">
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
                What was published
              </summary>
              <p className="text-muted-foreground mt-2 text-xs">
                The exact HTML and text stored at publish time. Delivery sends this and never
                re-renders the document.
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
        Subject: <span className="text-foreground">{state.data?.subject}</span>
      </p>
      <iframe
        title="Message preview"
        sandbox=""
        srcDoc={state.data?.html ?? ''}
        className="h-96 w-full rounded-lg border bg-white"
      />
      <p className="text-muted-foreground text-xs">
        Variables are shown as their {'{{name}}'} placeholders; each recipient gets their own values.
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
      toast.success('Sent — check the delivery log');
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
        Test send
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test</DialogTitle>
          <DialogDescription>
            This really sends, through the configured transport, and is recorded in the delivery
            log.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="test-to">To</Label>
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
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || to.trim() === ''}>
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
