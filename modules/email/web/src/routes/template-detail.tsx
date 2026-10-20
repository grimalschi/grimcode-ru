import { Link, useNavigate, useParams } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { api, messageOf } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/layout/page-loader';
import { useAsync } from '@/hooks/use-async';
import { useLate } from '@/hooks/use-late';
import { VERSION_STATUS_LABEL } from '@/status-labels';

const STATUS_VARIANT = {
  published: 'default',
  draft: 'secondary',
  archived: 'outline',
} as const;

/*
 * What the variables of the seeded templates mean, for whoever edits the wording. A variable added
 * later with its own template shows as its name alone until it is described here.
 */
const VARIABLE_MEANING: Record<string, string> = {
  email: 'адрес получателя',
  verificationUrl: 'ссылка для подтверждения почты',
  resetUrl: 'ссылка для сброса пароля',
  confirmUrl: 'ссылка для подтверждения нового адреса',
  previousEmail: 'прежний адрес, до смены',
};

/**
 * One template and its versions.
 *
 * At most one version is published, and that is the one runtime delivery sends. A draft is edited
 * freely; publishing is the moment the server checks it and produces the HTML and text that will
 * actually be sent.
 */
export function TemplateDetailPage() {
  const { templateId } = useParams({ from: '/templates/$templateId' });
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);

  const detail = useAsync(
    () => api.getTemplate.query({ id: templateId }),
    [templateId],
  );
  // The page appears whole once its first answer arrives; a loader only if that takes a while.
  const late = useLate(!detail.data && !detail.error);

  const createDraft = async () => {
    setBusy(true);
    try {
      const result = await api.createDraft.mutate({ templateId });
      toast.success(`Черновик v${result.version.version} создан`);
      detail.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (detail.error) {
    return (
      <AdminPage title="Шаблон">
        <ErrorState error={detail.error} retry={detail.reload} />
      </AdminPage>
    );
  }

  if (!detail.data) return <PageLoader late={late} />;

  const template = detail.data.template;

  return (
    <AdminPage
      title={template?.name ?? 'Шаблон'}
      description={
        template ? (
          <>
            <code>{template.key}</code>
            {template.description ? ` — ${template.description}` : null}
          </>
        ) : null
      }
      actions={
        <Button onClick={() => void createDraft()} disabled={busy}>
          Новый черновик
        </Button>
      }
    >
      {template && template.variables.length > 0 ? (
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-medium">Переменные</p>
            <p className="text-muted-foreground">
              Вставьте в текст письма — при отправке они заменятся настоящими значениями.
            </p>
          </div>
          {/* The same outlined badge as in the list of templates, the meaning in a column beside it. */}
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
            {template.variables.map((variable) => (
              <React.Fragment key={variable}>
                <dt>
                  <Badge variant="outline" className="font-mono">{`{{${variable}}}`}</Badge>
                </dt>
                <dd className="text-muted-foreground">{VARIABLE_MEANING[variable] ?? '—'}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      ) : null}

      <DataTable
        loading={detail.loading}
        rows={detail.data?.versions ?? []}
        rowKey={(row) => row.id}
        empty="Версий пока нет — создайте черновик."
        // The whole row opens the version, as on the list of templates.
        onRowClick={(row) => void navigate({ to: '/versions/$versionId', params: { versionId: row.id } })}
        columns={[
          {
            key: 'version',
            header: 'Версия',
            cell: (row) => (
              <Link
                to="/versions/$versionId"
                params={{ versionId: row.id }}
                className="font-medium"
              >
                Версия {row.version}
              </Link>
            ),
          },
          { key: 'subject', header: 'Тема', cell: (row) => row.subject },
          {
            key: 'status',
            header: 'Статус',
            cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{VERSION_STATUS_LABEL[row.status]}</Badge>,
          },
          {
            key: 'published',
            header: 'Опубликована',
            className: 'whitespace-nowrap',
            cell: (row) => (row.publishedAt ? new Date(row.publishedAt).toLocaleString() : '—'),
          },
        ]}
      />
    </AdminPage>
  );
}
