'use strict'
// Sets on the app exe what electron-builder's rcedit step (winPackager signAndEditResources) sets, with resedit, the
// library electron-builder already uses for the asar integrity resource. Needs win.signAndEditExecutable=false.
const fs = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const ResEdit = require(path.join(context.packager.info.projectDir, 'node_modules', 'resedit'))
  const appInfo = context.packager.appInfo
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`)
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath))
  const res = ResEdit.NtExecutableResource.from(exe)

  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
  const [lang] = vi.getAllLanguagesForStringValues()
  const strings = {
    FileDescription: appInfo.productName,
    ProductName: appInfo.productName,
    LegalCopyright: appInfo.copyright,
    InternalName: path.basename(exePath, '.exe'),
    OriginalFilename: '',
  }
  if (appInfo.companyName) strings.CompanyName = appInfo.companyName
  vi.setStringValues(lang, strings)
  const fileVersion = (appInfo.shortVersion || appInfo.buildVersion).split('.').map(Number)
  vi.setFileVersion(...[0, 1, 2, 3].map(i => fileVersion[i] || 0), lang.lang)
  const productVersion = (appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm()).split('.').map(Number)
  vi.setProductVersion(...[0, 1, 2, 3].map(i => productVersion[i] || 0), lang.lang)
  vi.outputToResourceEntries(res.entries)

  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(context.packager.info.projectDir, 'assets', 'icon.ico')))
  const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icon.icons.map(i => i.data))

  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log(`  • afterPack (no wine): version info and icon set on ${path.basename(exePath)}`)
}
