import { Link, useParams } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { api, messageOf } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAsync } from '@/hooks/use-async';

interface VersionSummary {
  id: string;
  locale: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  subject: string;
  publishedAt: string | null;
  updatedAt: string;
}

interface TemplateDetail {
  template: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    variables: string[];
  };
  versions: VersionSummary[];
}

const LOCALES = ['en', 'ru'];

const STATUS_VARIANT: Record<VersionSummary['status'], 'default' | 'outline' | 'secondary'> = {
  published: 'default',
  draft: 'secondary',
  archived: 'outline',
};

/**
 * One template and its versions.
 *
 * At most one version per language is published, and that is the one runtime delivery sends. A
 * draft is edited freely; publishing is the moment the server checks it and produces the HTML and
 * text that will actually be sent.
 */
export function TemplateDetailPage() {
  const { templateId } = useParams({ from: '/templates/$templateId' });
  const [locale, setLocale] = React.useState('en');
  const [busy, setBusy] = React.useState(false);

  const detail = useAsync<TemplateDetail>(() => api.getTemplate({ id: templateId }), [templateId]);

  const createDraft = async () => {
    setBusy(true);
    try {
      const result = await api.createDraft({ templateId, locale });
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

  const template = detail.data?.template;

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
        <div className="flex gap-2">
          <Select value={locale} onValueChange={setLocale}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => void createDraft()} disabled={busy}>
            Новый черновик
          </Button>
        </div>
      }
    >
      {template && template.variables.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          Переменные, которые может использовать шаблон:{' '}
          {template.variables.map((variable) => (
            <code key={variable} className="mr-2">
              {`{{${variable}}}`}
            </code>
          ))}
        </p>
      ) : null}

      <DataTable
        loading={detail.loading}
        rows={detail.data?.versions ?? []}
        rowKey={(row) => row.id}
        empty="Версий пока нет — создайте черновик."
        columns={[
          {
            key: 'version',
            header: 'Версия',
            cell: (row) => (
              <Link
                to="/versions/$versionId"
                params={{ versionId: row.id }}
                className="font-medium underline-offset-4 hover:underline"
              >
                {row.locale} · v{row.version}
              </Link>
            ),
          },
          { key: 'subject', header: 'Тема', cell: (row) => row.subject },
          {
            key: 'status',
            header: 'Статус',
            cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>,
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
