/* web-ext の設定。build と sign の両方に効く。
   配る .xpi に入れる必要の無い物をここで外す。作業用の物まで詰めると、
   AMO の検査もその中身を読みに行くため */
export default {
  ignoreFiles: [
    "tools/**",
    ".github/**",
    "CLAUDE.md",
    "README.md",
    "web-ext-config.mjs",
  ],
};
