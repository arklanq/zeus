declare const ZEUS_BUILD_VERSION: string | undefined;

export const DEVELOPMENT_VERSION = "development";

/** The release version embedded by build-release.ts; runs from source report "development". */
export const ZEUS_VERSION =
  typeof ZEUS_BUILD_VERSION === "string" ? ZEUS_BUILD_VERSION : DEVELOPMENT_VERSION;
