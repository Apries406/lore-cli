/** 当前 CLI 与采集器版本。 */
export const LORE_VERSION = "0.1.0";
/** 当前 Lore 元数据结构版本。 */
export const SCHEMA_VERSION = 1;
/** 当前生成与校验的 OKF 规范版本。 */
export const OKF_VERSION = "0.1";
/** 所有内容摘要统一使用 SHA-256，避免不同模块产生不兼容的 ID。 */
export const HASH_ALGORITHM = "sha256";
/** 面向人的短 ID 使用的摘要字符数；完整校验仍保存 64 位摘要。 */
export const IDENTIFIER_DIGEST_LENGTH = 12;
/** 持久化 ID 前缀，便于人和程序快速区分对象类型。 */
export const SOURCE_ID_PREFIX = "src_";
export const SNAPSHOT_ID_PREFIX = "snp_";
export const TEXT_ENCODING = "utf8";
export const FRONTMATTER_DELIMITER = "---";
/** 向上寻找 Vault 根目录时的防御性上限。 */
export const DEFAULT_MAX_PARENT_SEARCH_DEPTH = 64;
/** 默认只向语义阶段提供少量候选页，避免上下文无限膨胀。 */
export const DEFAULT_MAX_CANDIDATE_PAGES = 20;
export const ISO_DATE_LENGTH = 10;
export const SHA256_HEX_LENGTH = 64;
