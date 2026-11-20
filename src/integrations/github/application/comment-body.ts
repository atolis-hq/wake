/** Exclude the configured UI address from newly published GitHub text only. */
export function githubCommentBody(body: string, publicUiUrl: string | undefined): string {
  if (!publicUiUrl) return body;
  while (body.includes(publicUiUrl)) body = body.split(publicUiUrl).join('');
  return body;
}
