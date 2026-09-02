/** The app's ONE definition of search-box matching, shared by every
 *  picker and list filter: each whitespace-separated term of the query
 *  must appear somewhere in the haystack, case-insensitively. An empty
 *  query matches everything. */
export function matchesQuery(query: string, hay: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const h = hay.toLowerCase();
  return words.every((w) => h.includes(w));
}
