# Offline license admin utility

`../admin.html` is an **offline, owner-only** utility. It is intentionally not
an entry point of the Vite application. The production build is explicitly
limited to `index.html`, so `npm run build` / `npm run deploy` do not publish
this file.

Do not host, distribute, or treat this utility as an authenticated admin
portal. The current client-side Firebase license implementation is not secure
enough for a commercial multi-customer deployment. Move license administration
to an authenticated server-side service before relying on license enforcement.
