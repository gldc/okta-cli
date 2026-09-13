export async function mapConcurrent<T, R>(items: T[], workers: number, fn: (item: T, index: number) => Promise<R>, onProgress?: (done: number, total: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
      done++;
      onProgress?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, worker));
  return results;
}
