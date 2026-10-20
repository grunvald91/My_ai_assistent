const MAP = {
  sdk: '../shim/sdk.js',
  'sdk/db': '../shim/sdk-db.js',
  'sdk/api': '../shim/sdk-api.js',
  'sdk/fetch': '../shim/sdk-fetch.js',
};

export async function resolve(specifier, context, nextResolve) {
  if (MAP[specifier]) {
    return { url: new URL(MAP[specifier], import.meta.url).href, shortCircuit: true };
  }
  if (/\/lib\/secrets\.js$/.test(specifier)) {
    return { url: new URL('../shim/secrets.js', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
