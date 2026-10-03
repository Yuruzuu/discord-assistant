const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function success(structuredContent, extraContent = []) {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }, ...extraContent], structuredContent };
}

export function failure(error) {
  const structuredContent = {
    error: {
      message: error?.message || String(error),
      status: error?.status ?? null,
      code: error?.code ?? null,
      failures: error?.failures ?? null,
      ...(error?.nonce ? { nonce: error.nonce, sendStatus: error.sendStatus } : {}),
      ...(error?.batchId ? { batchId: error.batchId, sentMessages: error.sentMessages, failedMessageIndex: error.failedMessageIndex } : {}),
    },
  };

  return { content: [{ type: 'text', text: `Error: ${structuredContent.error.message}` }], structuredContent, isError: true };
}

export function register(server, name, options, handler) {
  server.registerTool(name, { ...options, annotations: { ...readOnlyAnnotations, title: options.title, ...options.annotations } }, async (args) => {
    try { return await handler(args); } catch (error) { return failure(error); }
  });
}
