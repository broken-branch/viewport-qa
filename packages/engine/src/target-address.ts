// A scheme with an authority (`https://`) or a file URL; `localhost:3000` is a host and port, not a scheme.
const SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|file:)/iu;
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/iu;
// host[:port][/path...] where host is a dotted name, an IPv4 address, or localhost.
const BARE_ADDRESS = /^(?<host>localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*|\[::1\])(?<port>:\d{1,5})?(?<rest>[/?#].*)?$/iu;

/**
 * Turns what a person typed into an absolute HTTP(S) URL, or null when the
 * text is not a web address. A bare host such as `example.com/pricing` is
 * completed with `https://`; loopback hosts get `http://`, since local
 * development servers rarely speak TLS. Text that already carries a scheme
 * is returned untouched, so file paths and explicit `http://` stay as given.
 */
export function normalizeTargetAddress(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  if (SCHEME.test(text)) return text;
  const match = BARE_ADDRESS.exec(text);
  if (!match?.groups) return null;
  const scheme = LOOPBACK_HOST.test(match.groups.host!) ? "http" : "https";
  try {
    return new URL(`${scheme}://${text}`).href;
  } catch {
    return null;
  }
}
