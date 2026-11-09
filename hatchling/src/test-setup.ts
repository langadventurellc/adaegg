// Runs before every test file. Test repos commit and merge through child `git` processes that
// inherit this environment; a global `commit.gpgsign=true` would make those commits wait on a
// passphrase prompt. GIT_CONFIG_COUNT entries override every config file.
process.env.GIT_CONFIG_COUNT = "2";
process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "tag.gpgsign";
process.env.GIT_CONFIG_VALUE_1 = "false";
