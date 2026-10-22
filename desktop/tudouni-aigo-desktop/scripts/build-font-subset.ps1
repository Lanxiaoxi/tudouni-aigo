# Rebuild the packaged JetBrains Maple Mono CJK subsets in src/fonts/.
#
# Two variants of the same fusion font (OFL-1.1,
# https://github.com/SpaceTimee/Fusion-JetBrainsMapleMono/releases):
#
#   default  JetBrainsMapleMono-XX-XX-XX-XX.zip
#            CJK at 1em, strict 2:1 with the JetBrains Mono latin. Used by
#            --font-mono (code / terminal / numerals), where alignment must
#            not break.
#   NR       JetBrainsMapleMono-XX-NR-XX-XX.zip
#            CJK narrowed to ~0.88em for a tighter body-text reading. Used
#            by --font-sans only, under the alias "JetBrains Maple Mono NR"
#            (both TTFs share the internal family name, so the alias is what
#            keeps the two @font-face blocks distinct).
#
# Usage:
#   .\scripts\build-font-subset.ps1 -Src <default TTF dir> -SrcNr <NR TTF dir>
# Each TTF dir is the release zip's layout: JetBrainsMapleMono-<Weight>.ttf.
#
# Dependencies: python 3 with fonttools + brotli, e.g.
#   uv tool install fonttools --with brotli     (installs pyftsubset)
# Each subset takes several minutes (brotli over the full CJK range);
# all eight together are roughly ten.
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$SrcNr
)

$ErrorActionPreference = 'Stop'
$Out = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path + '\src\fonts'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$py = @'
import os, subprocess, sys
src, src_nr, out = sys.argv[1], sys.argv[2], sys.argv[3]
# Full CJK unified range (4E00-9FFF) plus the scripts/symbols the UI shows.
# Deliberately wider than a GB2312-only cut so rare characters cannot
# silently fall back to the OS font and break the alignment; that is
# why each file lands at ~5.5 MB rather than ~1 MB.
ranges = [(0x0020, 0x007E), (0x00A0, 0x00FF), (0x0100, 0x02AF),
          (0x0300, 0x036F), (0x0370, 0x03FF), (0x0400, 0x04FF),
          (0x0500, 0x052F), (0x2000, 0x206F), (0x2190, 0x21FF),
          (0x2200, 0x22FF), (0x2300, 0x23FF), (0x2500, 0x25FF),
          (0x2600, 0x26FF), (0x2700, 0x27BF), (0x2B00, 0x2BFF),
          (0x3000, 0x30FF), (0x31C0, 0x31EF), (0x3200, 0x32FF),
          (0x4E00, 0x9FFF), (0xFE30, 0xFE4F), (0xFF00, 0xFFEF),
          (0x1F300, 0x1F64F), (0x1F680, 0x1F6FF), (0x1F900, 0x1F9FF)]
text = ' '.join('{:x}-{:x}'.format(a, b) if a != b else '{:x}'.format(a) for a, b in ranges)
weights = [('Regular', '400'), ('Medium', '500'), ('SemiBold', '600'), ('Bold', '700')]
for d, tag in ((src, ''), (src_nr, '-nr')):
    for name, num in weights:
        ttf = os.path.join(d, 'JetBrainsMapleMono-' + name + '.ttf')
        dst = os.path.join(out, 'jetbrains-maple-mono' + tag + '-' + num + '.woff2')
        r = subprocess.run(['pyftsubset', ttf,
                            '--output-file=' + dst, '--flavor=woff2',
                            '--unicodes=' + text,
                            '--layout-features=liga,calt', '--hinting=false'],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print('FAIL', tag, name, r.stderr[-2000:])
            sys.exit(1)
        print('OK', os.path.basename(dst), round(os.path.getsize(dst) / 1048576, 2), 'MB')
'@
$py | Set-Content -Path "$env:TEMP\jbm-subset.py" -Encoding ascii
python "$env:TEMP\jbm-subset.py" $Src $SrcNr $Out
