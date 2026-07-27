/**
 * A legal page.
 *
 * The template ships the structure of these documents, not their text: real terms and a real
 * privacy policy have to be written for the actual product and its jurisdiction. Every section
 * below is a heading with a note about what belongs in it, and the pages are marked `noindex` so a
 * placeholder is never mistaken for an agreement.
 */
export function LegalPage({
  title,
  sections,
}: {
  title: string;
  sections: readonly { heading: string; body: string }[];
}) {
  return (
    <article className="mx-auto w-full max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mt-4 text-sm">
        Это структура с заглушками, а не юридический текст. Замените каждый раздел до запуска.
      </p>

      <div className="mt-10 space-y-8">
        {sections.map((section, index) => (
          <section key={section.heading}>
            <h2 className="text-xl font-medium">
              {index + 1}. {section.heading}
            </h2>
            <p className="text-muted-foreground mt-2">{section.body}</p>
          </section>
        ))}
      </div>
    </article>
  );
}
