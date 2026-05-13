module.exports = {
  extends: ['next/core-web-vitals'],
  overrides: [
    {
      files: ['convex/**/*.ts'],
      excludedFiles: ['convex/lib/**', 'convex/_generated/**', 'convex/schema.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "MemberExpression[object.object.name='ctx'][object.property.name='db']",
            message: "Use the withWorkspace helper from convex/lib/auth.ts; raw ctx.db calls outside convex/lib/ are forbidden to prevent cross-tenant data leaks.",
          },
        ],
      },
    },
  ],
};
