function createOwnerOnlyMiddleware(ownerId) {
  return async (context, next) => {
    if (context.chat?.type !== 'private' || String(context.from?.id) !== ownerId) return;
    return next();
  };
}

module.exports = { createOwnerOnlyMiddleware };
