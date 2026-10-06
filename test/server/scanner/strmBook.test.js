const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const fs = require('fs/promises')
const os = require('os')
const Path = require('path')
const Database = require('../../../server/Database')
const BookScanner = require('../../../server/scanner/BookScanner')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const LibraryItemScanData = require('../../../server/scanner/LibraryItemScanData')
const ScanLogger = require('../../../server/scanner/ScanLogger')
const LibraryFile = require('../../../server/objects/files/LibraryFile')
const AudioMetaTags = require('../../../server/objects/metadata/AudioMetaTags')
const remoteAudio = require('../../../server/utils/remoteAudio')
const libraryFilters = require('../../../server/utils/queries/libraryFilters')
const Logger = require('../../../server/Logger')

describe('STRM 书籍入库、缓存与重扫', () => {
  let directory, library, folder, file, previousSettings, previousServerSettings, previousDatabase, previousMetadataPath

  beforeEach(async () => {
    directory = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-strm-book-'))
    previousMetadataPath = global.MetadataPath
    global.MetadataPath = directory
    previousSettings = global.ServerSettings
    previousServerSettings = Database.serverSettings
    previousDatabase = Database.sequelize
    global.ServerSettings = {}
    Database.serverSettings = { scannerFindCovers: false }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => str ? str[0].toUpperCase() + str.slice(1) : ''
    await Database.buildModels()
    library = await Database.libraryModel.create({ name: '有声书', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    folder = await Database.libraryFolderModel.create({ libraryId: library.id, path: directory })
    await libraryFilters.getFilterData('book', library.id)
    await fs.writeFile(Path.join(directory, '001.strm'), 'https://example.com/audio.m4a')
    file = new LibraryFile()
    await file.setDataFromPath(Path.join(directory, '001.strm'), '001.strm')
    sinon.stub(BookScanner, 'saveMetadataFile').resolves()
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.close()
    Database.sequelize = previousDatabase
    Database.serverSettings = previousServerSettings
    global.ServerSettings = previousSettings
    global.MetadataPath = previousMetadataPath
    await fs.rm(directory, { recursive: true, force: true })
  })

  function scanData() {
    return new LibraryItemScanData({ libraryFolderId: folder.id, libraryId: library.id, mediaType: 'book', path: directory, relPath: '书名', isFile: false, libraryFiles: [file], mediaMetadata: { title: '书名' } })
  }

  function validProbe(duration = 30) {
    return { audioStream: {}, duration, format: '音频容器', codec: 'aac', audioMetaTags: new AudioMetaTags(), remote: { mimeType: 'audio/mp4', size: 100000 } }
  }

  it('首次失败仍入库，重试恢复后缓存探测数据，后续故障保留已有时长', async () => {
    const probe = sinon.stub(remoteAudio, 'probe').resolves({ error: '来源暂时不可用' })
    const logger = new ScanLogger()
    const item = await BookScanner.scanNewBookLibraryItem(scanData(), library.settings, logger)
    expect(item).not.to.equal(null)
    let persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.audioFiles[0].error).to.equal('来源暂时不可用')
    expect(persisted.media.audioFiles[0].metadata.path).to.equal(file.metadata.path)

    probe.resolves(validProbe())
    await BookScanner.rescanExistingBookLibraryItem(persisted, scanData(), library.settings, logger)
    persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.duration).to.equal(30)
    expect(persisted.media.audioFiles[0].error).to.equal(null)
    expect(persisted.media.audioFiles[0].mimeType).to.equal('audio/mp4')
    expect(persisted.media.audioFiles[0].remote.size).to.equal(100000)

    probe.resetHistory()
    await BookScanner.rescanExistingBookLibraryItem(persisted, scanData(), library.settings, logger)
    expect(probe.called).to.equal(false)

    const forced = scanData()
    forced.forceRemoteProbe = true
    probe.resolves({ error: '网络故障' })
    await BookScanner.rescanExistingBookLibraryItem(persisted, forced, library.settings, logger)
    persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.duration).to.equal(30)
    expect(persisted.media.audioFiles[0].error).to.equal('网络故障')
    expect(persisted.media.audioFiles[0].remote.mimeType).to.equal('audio/mp4')

    probe.resolves(validProbe(40))
    await BookScanner.rescanExistingBookLibraryItem(persisted, scanData(), library.settings, logger)
    persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.duration).to.equal(40)
    expect(persisted.media.audioFiles[0].error).to.equal(null)
    expect(persisted.id).to.equal(item.id)
  })

  it('根目录的单个引用文件可以手动重扫，保留文件型书籍身份', async () => {
    const probe = sinon.stub(remoteAudio, 'probe').resolves(validProbe())
    const data = scanData()
    data.path = file.metadata.path
    data.relPath = file.metadata.filename
    data.isFile = true
    data.ino = file.ino
    const item = await BookScanner.scanNewBookLibraryItem(data, library.settings, new ScanLogger())
    probe.resolves(validProbe(45))
    await LibraryItemScanner.scanLibraryItem(item.id)
    const persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.isFile).to.equal(true)
    expect(persisted.libraryFiles).to.have.length(1)
    expect(persisted.media.duration).to.equal(45)
  })
})
