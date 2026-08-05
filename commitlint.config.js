export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Short, incremental commits: keep subjects tight and bodies wrapped.
    'header-max-length': [2, 'always', 72],
    'body-max-line-length': [2, 'always', 100],
  },
};
