export function Widget(data: { size: number }) {
  return (
    <section>
      // @ts-nocheck reads like a directive but is renderable JSX text
      <strong title={String(data.size as any)}>{data.size}</strong>
    </section>
  );
}
