# One-off: convert the hand-drawn icon in the design directory into the full
# icon set under src-tauri/icons.
#
# The source is a 1024x1024 PNG: a dark rounded square on a white background,
# with an "AI generated" watermark burned into the bottom-right corner. Three
# fixes are applied before resizing:
#   1. crop to the dark square (the white margin is dead weight at 16px);
#   2. repaint the watermark with the square's own background colour;
#   3. turn the remaining near-white pixels (outside the rounded corners) transparent.
#
# The ICO wraps PNG data for every size, which the format has allowed since
# Vista and which tauri-build accepts.

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$srcPath = Join-Path $PSScriptRoot '..\..\tudouni-aigo-desktop-design\icon'
$outDir = Join-Path $PSScriptRoot '..\src-tauri\icons'
$srcPath = [System.IO.Path]::GetFullPath($srcPath)
$outDir = [System.IO.Path]::GetFullPath($outDir)

$src = [System.Drawing.Bitmap]::new($srcPath)
Write-Host ("source: {0}x{1}" -f $src.Width, $src.Height)

# ---- 1. find the dark square and crop to it -------------------------------
# A pixel belongs to the square when it is clearly darker than the white page.
$minX = $src.Width; $minY = $src.Height; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $src.Height; $y += 2) {
  for ($x = 0; $x -lt $src.Width; $x += 2) {
    $p = $src.GetPixel($x, $y)
    if (($p.R + $p.G + $p.B) -lt 300) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
Write-Host ("square bounds: {0},{1} - {2},{3}" -f $minX, $minY, $maxX, $maxY)

$crop = $src.Clone([System.Drawing.Rectangle]::new($minX, $minY, $maxX - $minX + 1, $maxY - $minY + 1), $src.PixelFormat)
$src.Dispose()

# ---- 2. repaint the watermark ---------------------------------------------
# The watermark sits in the bottom-right of the square. Everything in that
# corner that is lighter than the dark background is watermark, not drawing
# (the rabbit is amber and sits well away from that corner), so it is repainted
# with the background colour sampled just left of the region.
$w = $crop.Width; $h = $crop.Height
$rw = [int]($w * 0.30); $rh = [int]($h * 0.14)
$rx = $w - $rw; $ry = $h - $rh
$bgSample = $crop.GetPixel([int]($w * 0.35), $h - 5)
$repainted = 0
for ($y = $ry; $y -lt $h; $y++) {
  for ($x = $rx; $x -lt $w; $x++) {
    $p = $crop.GetPixel($x, $y)
    if (($p.R + $p.G + $p.B) -gt 160) {
      $crop.SetPixel($x, $y, $bgSample)
      $repainted++
    }
  }
}
Write-Host ("watermark: repainted {0} px in region {1},{2} ({3}x{4}), bg={5},{6},{7}" -f $repainted, $rx, $ry, $rw, $rh, $bgSample.R, $bgSample.G, $bgSample.B)

# ---- 3. transparency outside the rounded corners ---------------------------
# Near-white is page, not drawing (the square is dark, the rabbit amber). A
# plain threshold leaves a faint light fringe at the corner edges; halving it
# towards the dark background first softens that without touching the drawing.
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $p = $crop.GetPixel($x, $y)
    if ($p.R -gt 240 -and $p.G -gt 240 -and $p.B -gt 240) {
      $crop.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    }
  }
}

# Master PNG, kept next to the generated ones for reference.
$masterPath = Join-Path $outDir 'source-icon.png'
$crop.Save($masterPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host ("master: {0} ({1}x{2})" -f $masterPath, $crop.Width, $crop.Height)

# ---- resize ----------------------------------------------------------------
function Resize([System.Drawing.Bitmap]$image, [int]$size) {
  $dst = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($image, 0, 0, $size, $size)
  $g.Dispose()
  return $dst
}

function PngBytes([System.Drawing.Bitmap]$image) {
  $ms = [System.IO.MemoryStream]::new()
  $image.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return $ms.ToArray()
}

$pngSizes = @(512, 256, 150, 142, 128, 107, 89, 71, 50, 48, 44, 32, 30)
$names = @{
  512 = 'icon.png'; 256 = '128x128@2x.png'; 128 = '128x128.png'; 32 = '32x32.png'
  30 = 'Square30x30Logo.png'; 44 = 'Square44x44Logo.png'; 71 = 'Square71x71Logo.png'
  89 = 'Square89x89Logo.png'; 107 = 'Square107x107Logo.png'; 142 = 'Square142x142Logo.png'
  150 = 'Square150x150Logo.png'; 284 = 'Square284x284Logo.png'; 310 = 'Square310x310Logo.png'
  50 = 'StoreLogo.png'
}
foreach ($size in $pngSizes) {
  if (-not $names.ContainsKey($size)) { continue }
  $bmp = Resize $crop $size
  $path = Join-Path $outDir $names[$size]
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  {0}  {1}px" -f $names[$size], $size)
}

# Extra sizes the names table above expects but the list skipped.
foreach ($size in @(284, 310)) {
  $bmp = Resize $crop $size
  $bmp.Save((Join-Path $outDir $names[$size]), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  {0}  {1}px" -f $names[$size], $size)
}

# ---- the ICO ---------------------------------------------------------------
# PNG-compressed entries at every size. The directory entries use 0 for 256.
# All integers are written through an explicit BitConverter little-endian path:
# PowerShell's BinaryWriter.Write overloads are ambiguous with [uint32] casts
# and silently write the wrong thing, which produces an ICO whose offsets are
# garbage — the file parses but no tool can read the images.
$icoSizes = @(16, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $icoSizes) {
  $bmp = Resize $crop $size
  $images += ,@{ Size = $size; Data = (PngBytes $bmp) }
  $bmp.Dispose()
}

$parts = [System.Collections.Generic.List[byte]]::new()

function Add-Le([System.Collections.Generic.List[byte]]$list, [int]$value, [int]$bytes) {
  for ($n = 0; $n -lt $bytes; $n++) {
    $list.Add([byte](($value -shr (8 * $n)) -band 0xFF))
  }
}

# Header: reserved, type=icon, count.
Add-Le $parts 0 2
Add-Le $parts 1 2
Add-Le $parts $images.Count 2

$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $s = if ($img.Size -ge 256) { 0 } else { $img.Size }
  $parts.Add([byte]$s)                 # width
  $parts.Add([byte]$s)                 # height
  $parts.Add([byte]0)                  # palette
  $parts.Add([byte]0)                  # reserved
  Add-Le $parts 1 2                    # colour planes
  Add-Le $parts 32 2                   # bits per pixel
  Add-Le $parts $img.Data.Length 4     # byte length
  Add-Le $parts $offset 4              # offset
  $offset += $img.Data.Length
}
foreach ($img in $images) {
  $parts.AddRange([byte[]]$img.Data)
}

[System.IO.File]::WriteAllBytes((Join-Path $outDir 'icon.ico'), $parts.ToArray())
Write-Host ("  icon.ico  {0} bytes ({1} entries)" -f $parts.Count, $images.Count)

$crop.Dispose()
Write-Host "done."
