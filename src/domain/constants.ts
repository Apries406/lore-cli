/** 当前 CLI 与采集器版本。 */
export const LORE_VERSION = "0.5.0";
/** 用户级 Lore 配置独立演进，不与 Vault Schema 版本绑定。 */
export const LORE_USER_CONFIG_VERSION = 1;
/** 支持在测试、容器和多配置环境中覆盖 Lore 用户目录与默认 Vault。 */
export const LORE_HOME_ENVIRONMENT_VARIABLE = "LORE_HOME";
export const LORE_ROOT_ENVIRONMENT_VARIABLE = "LORE_ROOT";
export const XDG_CONFIG_HOME_ENVIRONMENT_VARIABLE = "XDG_CONFIG_HOME";
export const XDG_DATA_HOME_ENVIRONMENT_VARIABLE = "XDG_DATA_HOME";
export const APP_DATA_ENVIRONMENT_VARIABLE = "APPDATA";
export const LOCAL_APP_DATA_ENVIRONMENT_VARIABLE = "LOCALAPPDATA";
export const LORE_CONFIG_DIRECTORY_NAME = "lore";
export const LORE_CONFIG_FILE_NAME = "config.yaml";
export const DEFAULT_VAULT_DIRECTORY_NAME = "vault";
/** 当前 Lore 元数据结构版本。 */
export const SCHEMA_VERSION = 4;
/** 当前生成与校验的 OKF 规范版本。 */
export const OKF_VERSION = "0.1";
/** 所有内容摘要统一使用 SHA-256，避免不同模块产生不兼容的 ID。 */
export const HASH_ALGORITHM = "sha256";
/** 面向人的短 ID 使用的摘要字符数；完整校验仍保存 64 位摘要。 */
export const IDENTIFIER_DIGEST_LENGTH = 12;
/** 持久化 ID 前缀，便于人和程序快速区分对象类型。 */
export const SOURCE_ID_PREFIX = "src_";
export const SNAPSHOT_ID_PREFIX = "snp_";
export const COMPILE_RUN_ID_PREFIX = "run_";
export const CONCEPT_ID_PREFIX = "con_";
export const MIGRATION_ID_PREFIX = "mig_";
export const QUERY_ID_PREFIX = "qry_";
export const TEXT_ENCODING = "utf8";
export const FRONTMATTER_DELIMITER = "---";
/** 向上寻找 Vault 根目录时的防御性上限。 */
export const DEFAULT_MAX_PARENT_SEARCH_DEPTH = 64;
/** 默认只向语义阶段提供少量候选页，避免上下文无限膨胀。 */
export const DEFAULT_MAX_CANDIDATE_PAGES = 20;
export const ISO_DATE_LENGTH = 10;
export const SHA256_HEX_LENGTH = 64;
/** 单次编译允许修改的页面数量上限。 */
export const DEFAULT_MAX_COMPILE_CHANGES = 8;
/** 单次编译允许创建的新页面数量上限。 */
export const DEFAULT_MAX_NEW_PAGES = 3;
/** 默认返回的 Wiki 查询候选数。 */
export const DEFAULT_QUERY_RESULT_LIMIT = 8;
/** Wiki 证据不足时最多返回的 Raw 摘录数。 */
export const DEFAULT_RAW_QUERY_RESULT_LIMIT = 5;
/** Wiki 首个候选低于该分数时允许回退 Raw。 */
export const DEFAULT_MIN_WIKI_QUERY_SCORE = 4;
/** Raw 摘录默认包含命中行前后的行数。 */
export const DEFAULT_RAW_EXCERPT_CONTEXT_LINES = 1;

export const DEFAULT_DASHBOARD_PORT = 4317;
export const DEFAULT_DASHBOARD_WINDOW_DAYS = 30;
export const DEFAULT_COLD_KNOWLEDGE_DAYS = 90;
/** BM25 的词频饱和参数。 */
export const BM25_TERM_SATURATION = 1.2;
/** BM25 的文档长度归一化参数。 */
export const BM25_LENGTH_NORMALIZATION = 0.75;
/** 查询字段权重，集中定义以避免检索实现散落魔法数字。 */
export const QUERY_TITLE_WEIGHT = 4;
export const QUERY_TAG_WEIGHT = 3;
export const QUERY_DESCRIPTION_WEIGHT = 1.5;
export const QUERY_EXACT_TITLE_BONUS = 10;
export const QUERY_LINK_CENTRALITY_WEIGHT = 0.25;
export const RAW_QUERY_TERM_WEIGHT = 2;
export const RAW_QUERY_TITLE_WEIGHT = 3;
/** Active Source 超过该天数没有新 Snapshot 时给出陈旧警告。 */
export const DEFAULT_SOURCE_STALE_AFTER_DAYS = 90;
/** 未完成编译任务超过该小时数时视为遗留运行状态。 */
export const DEFAULT_RUN_STALE_AFTER_HOURS = 24;
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
export const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
/** 单个采集结果的默认最大字节数，防止意外吞入巨型文件或响应。 */
export const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/** 目录与 Git Snapshot 最多包含的文本文件数。 */
export const DEFAULT_MAX_SOURCE_FILES = 1000;
/** 单个目录/Git 文件的最大字节数。 */
export const DEFAULT_MAX_COLLECTED_FILE_BYTES = 1024 * 1024;
/** Web 采集超时时间。 */
export const DEFAULT_WEB_TIMEOUT_MILLISECONDS = 30 * 1000;
/** Git diff 默认上下文行数。 */
export const DEFAULT_GIT_DIFF_CONTEXT_LINES = 3;
/** Wiki 页面相对路径必须位于 pages/ 且使用稳定英文 slug。 */
export const WIKI_PAGE_PATH_PATTERN = "^wiki/pages/[a-z0-9][a-z0-9-]*\\.md$";
/** 第一版 Evidence 使用不可变 Snapshot 中的 1-based 行区间。 */
export const LINE_RANGE_LOCATOR_PATTERN = "^line:([1-9][0-9]*)-([1-9][0-9]*)$";
