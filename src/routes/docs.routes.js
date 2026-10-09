import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { loadSpec } from '../openapi/spec.js';

// Swagger UI assets come from the swagger-ui-dist package, never a CDN, so the page
// works on the plant network and needs nothing but 'self' in its CSP.
const DOCS_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const UI_OPTIONS = {
  customSiteTitle: 'DockFlow & Power Tool API docs',
  // Relative to /docs/, so the page also works behind a path-prefixing proxy. Setting it
  // also stops the UI from loading an arbitrary spec passed as ?url=.
  swaggerUrl: '../openapi.json',
  swaggerOptions: {
    // Keep the API key in memory only; don't persist it to localStorage.
    persistAuthorization: false,
    // Don't send the spec URL to the public validator.swagger.io service.
    validatorUrl: null,
    supportedSubmitMethods: ['get', 'post'],
    displayRequestDuration: true,
    displayOperationId: true,
    filter: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
  },
};

// Open (no API key): the contract contains no secrets, and "Authorize" in the UI is
// how a key is supplied for "Try it out". Disable with DOCS_ENABLED=false.
export function docsRoutes() {
  const { yaml, document } = loadSpec();
  const router = Router();

  router.get('/openapi.json', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(document);
  });

  router.get('/openapi.yaml', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/yaml').send(yaml);
  });

  // The UI's asset links are relative, so it must be served from /docs/.
  router.get('/docs', (req, res, next) => {
    if (req.path === '/docs') return res.redirect(301, 'docs/');
    next();
  });

  router.use(
    '/docs',
    (_req, res, next) => {
      res.set('Content-Security-Policy', DOCS_CSP);
      next();
    },
    swaggerUi.serveFiles(null, UI_OPTIONS),
    swaggerUi.setup(null, UI_OPTIONS)
  );

  return router;
}
