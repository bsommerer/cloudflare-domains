// Abruf einer Datei aus einem GitHub-Repo über die Contents-API.
// `Accept: application/vnd.github.raw` liefert den Dateiinhalt direkt.

export function githubFetcher({ token, fetchImpl = fetch } = {}) {
  return async ({ repo, path, ref }) => {
    const url =
      `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}` +
      (ref ? `?ref=${encodeURIComponent(ref)}` : "");
    const headers = {
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cloudflare-domains-check-wrangler",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetchImpl(url, { headers });
      if (res.ok) return { status: "ok", text: await res.text() };
      // Private Repos ohne Recht antworten bewusst mit 404, nicht 403.
      if (res.status === 404) return { status: "missing", detail: token ? "HTTP 404" : "HTTP 404, kein Token gesetzt" };
      if (res.status === 401 || res.status === 403) return { status: "denied", detail: `HTTP ${res.status}` };
      return { status: "error", detail: `HTTP ${res.status}` };
    } catch (e) {
      return { status: "error", detail: e.message };
    }
  };
}
