//! Local reference images only. No Provider calls, remote URLs or browser-supplied paths.
use super::workspace::{managed_dir, write_new_file};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::{fs, io::{Cursor, Read}, path::{Path, PathBuf}};
use uuid::Uuid;

pub(crate) const IMPORT_LIMIT: usize = 10 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AssetRole { Reference, Character, Location, Prop, Other }

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RasterFormat { Png, Jpg, Webp }

impl RasterFormat {
  pub(crate) fn extension(self) -> &'static str { match self { Self::Png => "png", Self::Jpg => "jpg", Self::Webp => "webp" } }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReferenceAsset {
  pub id: Uuid,
  pub name: String,
  pub original_name: String,
  pub role: AssetRole,
  pub notes: String,
  pub format: RasterFormat,
  pub bytes: u64,
  pub width: u32,
  pub height: u32,
  pub hash: String,
  pub preview_hash: String,
}

impl ReferenceAsset {
  pub(crate) fn relative_path(&self) -> String { format!("creative/references/{}.{}", self.id, self.format.extension()) }
}

pub(crate) struct PreparedImage { pub asset: ReferenceAsset, pub preview: Vec<u8> }

fn reader(bytes: &[u8], format: ImageFormat) -> ImageReader<Cursor<&[u8]>> {
  let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
  let mut limits = Limits::default();
  limits.max_image_width = Some(12000);
  limits.max_image_height = Some(12000);
  limits.max_alloc = Some(128 * 1024 * 1024);
  reader.limits(limits);
  reader
}

pub(crate) fn prepare(bytes: &[u8], name: String, original_name: String, role: AssetRole) -> Result<PreparedImage, String> {
  if bytes.is_empty() || bytes.len() > IMPORT_LIMIT { return Err("图片须为 1 字节至 10 MiB。".into()); }
  let format = image::guess_format(bytes).map_err(|_| "只支持完整的 PNG、JPEG 或 WebP 图片。")?;
  let raster = match format {
    ImageFormat::Png => RasterFormat::Png,
    ImageFormat::Jpeg => RasterFormat::Jpg,
    ImageFormat::WebP => RasterFormat::Webp,
    _ => return Err("只支持 PNG、JPEG 或 WebP；不支持 SVG、GIF 或视频。".into()),
  };
  let (width, height) = reader(bytes, format).into_dimensions().map_err(|_| "图片头不完整或尺寸超出限制。")?;
  if width == 0 || height == 0 || width > 12000 || height > 12000 || u64::from(width) * u64::from(height) > 24_000_000 {
    return Err("图片最大边长为 12000 像素，总像素不超过 24 MP。".into());
  }
  // Fully decode within limits, rather than accepting a file that only has a plausible header.
  let decoded = reader(bytes, format).decode().map_err(|_| "图片损坏、不完整或解码所需内存超出限制；未导入。")?;
  let thumbnail = decoded.thumbnail(512, 512);
  let mut preview = Cursor::new(Vec::new());
  thumbnail.write_to(&mut preview, ImageFormat::Png).map_err(|_| "无法建立图片预览。")?;
  let preview = preview.into_inner();
  if preview.len() > PREVIEW_LIMIT { return Err("图片预览超过大小限制。".into()); }
  Ok(PreparedImage { asset: ReferenceAsset {
    id: Uuid::new_v4(), name, original_name, role, notes: String::new(), format: raster,
    bytes: bytes.len() as u64, width, height, hash: blake3::hash(bytes).to_hex().to_string(),
    preview_hash: blake3::hash(&preview).to_hex().to_string(),
  }, preview })
}

fn paths(root: &Path, asset: &ReferenceAsset, create: bool) -> Result<(PathBuf, PathBuf), String> {
  let dir = managed_dir(root, &["creative", "references"], create)?.ok_or("参考图目录已移动或丢失。")?;
  Ok((dir.join(format!("{}.{}", asset.id, asset.format.extension())), dir.join(format!("{}.preview.png", asset.id))))
}

pub(crate) fn read_limited(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
  let meta = match fs::symlink_metadata(path) {
    Ok(meta) if meta.is_file() => meta,
    Ok(_) => return Err("只支持作品内的普通文件，不能读取链接或目录。".into()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("读取素材文件失败：{e}")),
  };
  if meta.len() > limit as u64 { return Err("素材文件超过大小限制。".into()); }
  let mut bytes = Vec::new();
  fs::File::open(path).and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut bytes)).map_err(|e| format!("读取素材失败：{e}"))?;
  if bytes.len() > limit { return Err("素材文件超过大小限制。".into()); }
  Ok(Some(bytes))
}

pub(crate) fn store(root: &Path, prepared: &PreparedImage, original: &[u8]) -> Result<(), String> {
  let (source, preview) = paths(root, &prepared.asset, true)?;
  write_new_file(&source, original).map_err(|e| format!("保存原图失败：{e}"))?;
  if let Err(e) = write_new_file(&preview, &prepared.preview) {
    let _ = fs::remove_file(source);
    return Err(format!("保存预览失败：{e}"));
  }
  Ok(())
}

/// Only called for files created by this exact, failed import; never for an existing asset.
pub(crate) fn rollback_import(root: &Path, asset: &ReferenceAsset) {
  if let Ok((source, preview)) = paths(root, asset, false) {
    let _ = fs::remove_file(source);
    let _ = fs::remove_file(preview);
  }
}

pub(crate) fn available(root: &Path, asset: &ReferenceAsset) -> bool {
  paths(root, asset, false).is_ok_and(|(source, preview)| {
    fs::symlink_metadata(source).is_ok_and(|meta| meta.is_file() && meta.len() == asset.bytes)
      && fs::symlink_metadata(preview).is_ok_and(|meta| meta.is_file() && meta.len() <= PREVIEW_LIMIT as u64)
  })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagePreview { pub mime: &'static str, pub base64: String }

pub(crate) fn preview(root: &Path, asset: &ReferenceAsset) -> Result<ImagePreview, String> {
  let (source, preview) = paths(root, asset, false)?;
  let original = read_limited(&source, IMPORT_LIMIT)?.ok_or("原始图片已移动或丢失；分镜记录仍保留。")?;
  if original.len() as u64 != asset.bytes || blake3::hash(&original).to_hex().as_str() != asset.hash {
    return Err("原始图片已被外部修改，请重新导入；未更改分镜。".into());
  }
  let bytes = read_limited(&preview, PREVIEW_LIMIT)?.ok_or("图片预览已移动或丢失，请重新导入。")?;
  if blake3::hash(&bytes).to_hex().as_str() != asset.preview_hash { return Err("图片预览已被外部修改，请重新导入。".into()); }
  Ok(ImagePreview { mime: "image/png", base64: STANDARD.encode(bytes) })
}

#[cfg(test)]
pub(crate) fn fixture_png() -> Vec<u8> {
  let image = image::DynamicImage::new_rgb8(2, 2);
  let mut bytes = Cursor::new(Vec::new());
  image.write_to(&mut bytes, ImageFormat::Png).unwrap();
  bytes.into_inner()
}
