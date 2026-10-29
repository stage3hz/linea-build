export async function addSelectionQueue<T, R>(items: T[], actions: {
  isCurrent: () => boolean;
  resolve: (item: T) => Promise<R>;
  add: (item: R) => Promise<void>;
  added: (item: T, completed: number) => void;
  dispose?: (item: R) => Promise<void>;
}): Promise<void> {
  let completed = 0;
  for (const item of items) {
    if (!actions.isCurrent()) return;
    const resolved = await actions.resolve(item);
    try {
      if (!actions.isCurrent()) return;
      await actions.add(resolved);
      if (!actions.isCurrent()) return;
      actions.added(item, ++completed);
    } finally { await actions.dispose?.(resolved); }
  }
}
