const API = (() => {
  const TOKEN_KEY = 'survey_token';
  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

  async function request(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!res.ok) {
      const detail = (data && data.details && data.details[0] && (data.details[0].message || data.details[0])) || (data && data.error) || `请求失败 (${res.status})`;
      const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  return {
    getToken, setToken,
    get: (u) => request('GET', u), post: (u, b) => request('POST', u, b),
    put: (u, b) => request('PUT', u, b), patch: (u, b) => request('PATCH', u, b),
    del: (u) => request('DELETE', u),
  };
})();