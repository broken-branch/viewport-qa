import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// Darwin exposes its OS-owned temporary directory through /var even though
// /var is an OS symlink to /private/var. Canonicalize that trusted fixture
// boundary once; product-selected report/cache paths remain untouched.
if (process.platform === "darwin") process.env.TMPDIR = realpathSync(tmpdir());
