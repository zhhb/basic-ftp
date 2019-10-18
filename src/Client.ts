import { createReadStream, createWriteStream, mkdir, readdir, stat, open, close, unlink } from "fs"
import { join } from "path"
import { Readable, Writable } from "stream"
import { ConnectionOptions } from "tls"
import { promisify } from "util"
import { FileInfo } from "./FileInfo"
import { FTPContext, FTPError, FTPResponse } from "./FtpContext"
import { createNullObject } from "./nullObject"
import { parseList as parseListAutoDetect } from "./parseList"
import { ProgressHandler, ProgressTracker } from "./ProgressTracker"
import { StringWriter } from "./StringWriter"
import { parseMLSxDate } from "./parseListMLSD"
import { describeAddress, describeTLS, upgradeSocket } from "./netUtils"
import { upload, download, enterPassiveModeIPv6, enterPassiveModeIPv4, UploadCommand } from "./transfer"
import { isMultiline, positiveCompletion } from "./parseControlResponse"

// Use promisify to keep the library compatible with Node 8.
const fsReadDir = promisify(readdir)
const fsMkDir = promisify(mkdir)
const fsStat = promisify(stat)
const fsOpen = promisify(open)
const fsClose = promisify(close)
const fsUnlink = promisify(unlink)

export interface AccessOptions {
    /** Host the client should connect to. Optional, default is "localhost". */
    readonly host?: string
    /** Port the client should connect to. Optional, default is 21. */
    readonly port?: number
    /** Username to use for login. Optional, default is "anonymous". */
    readonly user?: string
    /** Password to use for login. Optional, default is "guest". */
    readonly password?: string
    /** Use explicit FTPS over TLS. Optional, default is false. */
    readonly secure?: boolean
    /** TLS options as in [tls.connect(options)](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback), optional. */
    readonly secureOptions?: ConnectionOptions
}

/** Prepares a data connection for transfer. */
export type TransferStrategy = (ftp: FTPContext) => Promise<FTPResponse>

/** Parses raw directoy listing data. */
export type RawListParser = (rawList: string) => FileInfo[]

export interface UploadOptions {
    localStart?: number
    localEndInclusive?: number
}

/**
 * High-level API to interact with an FTP server.
 */
export class Client {
    prepareTransfer: TransferStrategy
    parseList: RawListParser
    /**
     * Multiple commands to retrieve a directory listing are possible. This instance
     * will try all of them in the order presented the first time a directory listing
     * is requested. After that, `availableListCommands` will  hold only the first
     * entry that worked.
     */
    availableListCommands = ["MLSD", "LIST -a", "LIST"]
    /** Low-level API to interact with FTP server. */
    readonly ftp: FTPContext
    /** Tracks progress of data transfers. */
    protected _progressTracker: ProgressTracker

    /**
     * Instantiate an FTP client.
     *
     * @param timeout  Timeout in milliseconds, use 0 for no timeout. Optional, default is 30 seconds.
     */
    constructor(timeout = 30000) {
        this.ftp = new FTPContext(timeout)
        this.prepareTransfer = enterFirstCompatibleMode([enterPassiveModeIPv6, enterPassiveModeIPv4], this)
        this.parseList = parseListAutoDetect
        this._progressTracker = new ProgressTracker()
    }

    /**
     * Close the client and all open socket connections.
     *
     * Close the client and all open socket connections. The client can’t be used anymore after calling this method,
     * you have to either reconnect with `access` or `connect` or instantiate a new instance to continue any work.
     * A client is also closed automatically if any timeout or connection error occurs.
     */
    close() {
        this.ftp.close()
        this._progressTracker.stop()
    }

    /**
     * Returns true if the client is closed and can't be used anymore.
     */
    get closed(): boolean {
        return this.ftp.closed
    }

    /**
     * Connect (or reconnect) to an FTP server.
     *
     * This is an instance method and thus can be called multiple times during the lifecycle of a `Client`
     * instance. Whenever you do, the client is reset with a new control connection. This also implies that
     * you can reopen a `Client` instance that has been closed due to an error when reconnecting with this
     * method. In fact, reconnecting is the only way to continue using a closed `Client`.
     *
     * @param host  Host the client should connect to. Optional, default is "localhost".
     * @param port  Port the client should connect to. Optional, default is 21.
     */
    connect(host = "localhost", port = 21): Promise<FTPResponse> {
        this.ftp.reset()
        this.ftp.socket.connect({
            host,
            port,
            family: this.ftp.ipFamily
        }, () => this.ftp.log(`Connected to ${describeAddress(this.ftp.socket)}`))
        return this.ftp.handle(undefined, (res, task) => {
            if (res instanceof Error) {
                // The connection has been destroyed by the FTPContext at this point.
                task.reject(res)
            }
            else if (positiveCompletion(res.code)) {
                task.resolve(res)
            }
            // Reject all other codes, including 120 "Service ready in nnn minutes".
            else {
                // Don't stay connected but don't replace the socket yet by using reset()
                // so the user can inspect properties of this instance.
                this.ftp.socket.destroy()
                task.reject(new FTPError(res))
            }
        })
    }

    /**
     * Send an FTP command and handle the first response.
     */
    send(command: string, ignoreErrorCodesDEPRECATED = false): Promise<FTPResponse> {
        if (ignoreErrorCodesDEPRECATED) { // Deprecated starting from 3.9.0
            this.ftp.log("Deprecated call using send(command, flag) with boolean flag to ignore errors. Use sendIgnoringError(command).")
            return this.sendIgnoringError(command)
        }
        return this.ftp.request(command)
    }

    /**
     * Send an FTP command and ignore an FTP error response. Any other kind of error or timeout will still reject the Promise.
     *
     * @param command
     */
    sendIgnoringError(command: string): Promise<FTPResponse> {
        return this.ftp.handle(command, (res, task) => {
            if (res instanceof FTPError) {
                task.resolve({code: res.code, message: res.message})
            }
            else if (res instanceof Error) {
                task.reject(res)
            }
            else {
                task.resolve(res)
            }
        })
    }

    /**
     * Upgrade the current socket connection to TLS.
     *
     * @param options  TLS options as in `tls.connect(options)`, optional.
     * @param command  Set the authentication command. Optional, default is "AUTH TLS".
     */
    async useTLS(options: ConnectionOptions = {}, command = "AUTH TLS"): Promise<FTPResponse> {
        const ret = await this.send(command)
        this.ftp.socket = await upgradeSocket(this.ftp.socket, options)
        this.ftp.tlsOptions = options // Keep the TLS options for later data connections that should use the same options.
        this.ftp.log(`Control socket is using: ${describeTLS(this.ftp.socket)}`)
        return ret
    }

    /**
     * Login a user with a password.
     *
     * @param user  Username to use for login. Optional, default is "anonymous".
     * @param password  Password to use for login. Optional, default is "guest".
     */
    login(user = "anonymous", password = "guest"): Promise<FTPResponse> {
        this.ftp.log(`Login security: ${describeTLS(this.ftp.socket)}`)
        return this.ftp.handle("USER " + user, (res, task) => {
            if (res instanceof Error) {
                task.reject(res)
            }
            else if (positiveCompletion(res.code)) { // User logged in proceed OR Command superfluous
                task.resolve(res)
            }
            else if (res.code === 331) { // User name okay, need password
                this.ftp.send("PASS " + password)
            }
            else { // Also report error on 332 (Need account)
                task.reject(new FTPError(res))
            }
        })
    }

    /**
     * Set the usual default settings.
     *
     * Settings used:
     * * Binary mode (TYPE I)
     * * File structure (STRU F)
     * * Additional settings for FTPS (PBSZ 0, PROT P)
     */
    async useDefaultSettings(): Promise<void> {
        await this.send("TYPE I") // Binary mode
        await this.sendIgnoringError("STRU F") // Use file structure
        await this.sendIgnoringError("OPTS UTF8 ON") // Some servers expect UTF-8 to be enabled explicitly
        await this.sendIgnoringError("OPTS MLST type;size;modify;unique;unix.mode;unix.owner;unix.group;unix.ownername;unix.groupname;") // Make sure MLSD listings include all we can parse
        if (this.ftp.hasTLS) {
            await this.sendIgnoringError("PBSZ 0") // Set to 0 for TLS
            await this.sendIgnoringError("PROT P") // Protect channel (also for data connections)
        }
    }

    /**
     * Convenience method that calls `connect`, `useTLS`, `login` and `useDefaultSettings`.
     *
     * This is an instance method and thus can be called multiple times during the lifecycle of a `Client`
     * instance. Whenever you do, the client is reset with a new control connection. This also implies that
     * you can reopen a `Client` instance that has been closed due to an error when reconnecting with this
     * method. In fact, reconnecting is the only way to continue using a closed `Client`.
     */
    async access(options: AccessOptions = {}): Promise<FTPResponse> {
        const welcome = await this.connect(options.host, options.port)
        if (options.secure === true) {
            await this.useTLS(options.secureOptions)
        }
        await this.login(options.user, options.password)
        await this.useDefaultSettings()
        return welcome
    }

    /**
     * Get the current working directory.
     */
    async pwd(): Promise<string> {
        const res = await this.send("PWD")
        // The directory is part of the return message, for example:
        // 257 "/this/that" is current directory.
        const parsed = res.message.match(/"(.+)"/)
        if (parsed === null || parsed[1] === undefined) {
            throw new Error(`Can't parse response to command 'PWD': ${res.message}`)
        }
        return parsed[1]
    }

    /**
     * Get a description of supported features.
     *
     * This sends the FEAT command and parses the result into a Map where keys correspond to available commands
     * and values hold further information. Be aware that your FTP servers might not support this
     * command in which case this method will not throw an exception but just return an empty Map.
     */
    async features(): Promise<Map<string, string>> {
        const res = await this.sendIgnoringError("FEAT")
        const features = new Map()
        // Not supporting any special features will be reported with a single line.
        if (res.code < 400 && isMultiline(res.message)) {
            // The first and last line wrap the multiline response, ignore them.
            res.message.split("\n").slice(1, -1).forEach(line => {
                // A typical lines looks like: " REST STREAM" or " MDTM".
                // Servers might not use an indentation though.
                const entry = line.trim().split(" ")
                features.set(entry[0], entry[1] || "")
            })
        }
        return features
    }

    /**
     * Set the working directory.
     */
    async cd(path: string): Promise<FTPResponse> {
        const validPath = await this.protectWhitespace(path)
        return this.send("CWD " + validPath)
    }

    /**
     * Switch to the parent directory of the working directory.
     */
    async cdup(): Promise<FTPResponse> {
        return this.send("CDUP")
    }

    /**
     * Get the last modified time of a file. This is not supported by every FTP server, in which case
     * calling this method will throw an exception.
     */
    async lastMod(path: string): Promise<Date> {
        const validPath = await this.protectWhitespace(path)
        const res = await this.send(`MDTM ${validPath}`)
        const date = res.message.slice(4)
        return parseMLSxDate(date)
    }

    /**
     * Get the size of a file.
     */
    async size(path: string): Promise<number> {
        const validPath = await this.protectWhitespace(path)
        const command = `SIZE ${validPath}`
        const res = await this.send(command)
        // The size is part of the response message, for example: "213 555555". It's
        // possible that there is a commmentary appended like "213 5555, some commentary".
        const size = parseInt(res.message.slice(4), 10)
        if (Number.isNaN(size)) {
            throw new Error(`Can't parse response to command '${command}' as a numerical value: ${res.message}`)
        }
        return size
    }

    /**
     * Rename a file.
     *
     * Depending on the FTP server this might also be used to move a file from one
     * directory to another by providing full paths.
     */
    async rename(srcPath: string, destPath: string): Promise<FTPResponse> {
        const validSrc = await this.protectWhitespace(srcPath)
        const validDest = await this.protectWhitespace(destPath)
        await this.send("RNFR " + validSrc)
        return this.send("RNTO " + validDest)
    }

    /**
     * Remove a file from the current working directory.
     *
     * You can ignore FTP error return codes which won't throw an exception if e.g.
     * the file doesn't exist.
     */
    async remove(path: string, ignoreErrorCodes = false): Promise<FTPResponse> {
        const validPath = await this.protectWhitespace(path)
        return this.send(`DELE ${validPath}`, ignoreErrorCodes)
    }

    /**
     * Report transfer progress for any upload or download to a given handler.
     *
     * This will also reset the overall transfer counter that can be used for multiple transfers. You can
     * also pass `undefined` as a handler to stop reporting to an earlier one.
     *
     * @param handler  Handler function to call on transfer progress.
     */
    trackProgress(handler: ProgressHandler) {
        this._progressTracker.bytesOverall = 0
        this._progressTracker.reportTo(handler)
    }

    /**
     * Upload data from a readable stream or a local file to a remote file.
     *
     * @param source  Readable stream or path to a local file.
     * @param remotePath  Path to a remote file to write to.
     */
    async upload(source: Readable | string, remotePath: string, options: UploadOptions = {}): Promise<FTPResponse> {
        return this._uploadWithCommand(source, remotePath, "STOR", options)
    }

    /**
     * Upload data from a readable stream or a local file by appending it to an existing file. If the file doesn't
     * exist the FTP server should create it.
     *
     * @param source  Readable stream or path to a local file.
     * @param remotePath  Path to a remote file to write to.
     */
    async append(source: Readable | string, remotePath: string, options: UploadOptions = {}): Promise<FTPResponse> {
        return this._uploadWithCommand(source, remotePath, "APPE", options)
    }

    protected async _uploadWithCommand(source: Readable | string, remotePath: string, command: UploadCommand, options: UploadOptions): Promise<FTPResponse> {
        if (typeof source === "string") {
            return this._uploadLocalFile(source, remotePath, command, options)
        }
        return this._uploadFromStream(source, remotePath, command)
    }

    protected async _uploadLocalFile(localPath: string, remotePath: string, command: UploadCommand, options: UploadOptions): Promise<FTPResponse> {
        const fd = await fsOpen(localPath, "r")
        const source = createReadStream("", {
            fd,
            start: options.localStart,
            end: options.localEndInclusive,
            autoClose: false
        })
        try {
            return await this._uploadFromStream(source, remotePath, command)
        }
        finally {
            await ignoreException(() => fsClose(fd))
        }
    }

    /**
     * @protected
     */
    protected async _uploadFromStream(source: Readable, remotePath: string, command: UploadCommand): Promise<FTPResponse> {
        const onError = (err: Error) => this.ftp.closeWithError(err)
        source.once("error", onError)
        try {
            const validPath = await this.protectWhitespace(remotePath)
            await this.prepareTransfer(this.ftp)
            // Keep the keyword `await` or the `finally` clause below runs too early
            // and removes the event listener for the source stream too early.
            return await upload(this.ftp, this._progressTracker, source, command, validPath)
        }
        finally {
            source.removeListener("error", onError)
        }
    }

    /**
     * Download a remote file and pipe its data to a writable stream or to a local file.
     *
     * You can set `remoteStart` to start downloading at a given position of the remote file. You can
     * also set `localStart` to start writing at a specific position within a local file. An exception
     * will be thrown if the local file doesn't exist if `localStart` is larger than 0.
     *
     * @param toDestination  Stream or path for a local file to write to.
     * @param remotePath  Path of the remote file to read from.
     * @param remoteStart  Position within the remote file to start downloading at.
     * @param localStart  Position within an existing local file to start writing to. Only used if destination is a file.
     */
    async download(toDestination: Writable | string, remotePath: string, remoteStart = 0, localStart = 0) {
        if (typeof toDestination === "string") {
            return this._downloadToFile(toDestination, remotePath, remoteStart, localStart)
        }
        return this._downloadToStream(toDestination, remotePath, remoteStart)
    }

    protected async _downloadToFile(localPath: string, remotePath: string, remoteStart: number, localStart: number) {
        const expectLocalFile = localStart > 0
        const fileSystemFlags = expectLocalFile ? "r+" : "w"
        const fd = await fsOpen(localPath, fileSystemFlags)
        const destination = createWriteStream("", {
            fd,
            start: localStart,
            autoClose: false
        })
        try {
            return await this._downloadToStream(destination, remotePath, remoteStart)
        }
        catch(err) {
            if (!expectLocalFile) {
                await ignoreException(() => fsUnlink(localPath))
            }
            throw err
        }
        finally {
            await ignoreException(() => fsClose(fd))
        }
    }

    protected async _downloadToStream(destination: Writable, remotePath: string, startAt: number): Promise<FTPResponse> {
        const onError = (err: Error) => this.ftp.closeWithError(err)
        destination.once("error", onError)
        try {
            const validPath = await this.protectWhitespace(remotePath)
            await this.prepareTransfer(this.ftp)
            const command = startAt > 0 ? `REST ${startAt}` : `RETR ${validPath}`
            // Keep the keyword `await` or the `finally` clause below runs too early
            // and removes the event listener for the source stream too early.
            return await download(this.ftp, this._progressTracker, destination, command, validPath)
        }
        finally {
            destination.removeListener("error", onError)
        }
    }

    /**
     * List files and directories in the current working directory, or from `path` if specified.
     *
     * @param [path]  Path to remote file or directory.
     */
    async list(path = ""): Promise<FileInfo[]> {
        const validPath = await this.protectWhitespace(path)
        let lastError: any
        for (const candidate of this.availableListCommands) {
            const command = `${candidate} ${validPath}`.trim()
            await this.prepareTransfer(this.ftp)
            try {
                const parsedList = await this._requestListWithCommand(command)
                // Use successful candidate for all subsequent requests.
                this.availableListCommands = [ candidate ]
                return parsedList
            }
            catch (err) {
                const maybeSyntaxError = err instanceof FTPError && err.code >= 500
                if (!maybeSyntaxError) {
                    throw err
                }
                lastError = err
            }
        }
        throw lastError
    }

    /**
     * @protected
     */
    protected async _requestListWithCommand(command: string): Promise<FileInfo[]> {
        const writable = new StringWriter()
        const noTracker = createNullObject() as ProgressTracker // Don't track progress of list transfers.
        await download(this.ftp, noTracker, writable, command)
        const text = writable.getText(this.ftp.encoding)
        this.ftp.log(text)
        return this.parseList(text)
    }

    /**
     * Remove a directory and all of its content.
     *
     * After successfull completion the current working directory will be the parent
     * of the removed directory if possible.
     *
     * @param remoteDirPath  The path of the remote directory to delete.
     * @example client.removeDir("foo") // Remove directory 'foo' using a relative path.
     * @example client.removeDir("foo/bar") // Remove directory 'bar' using a relative path.
     * @example client.removeDir("/foo/bar") // Remove directory 'bar' using an absolute path.
     * @example client.removeDir("/") // Remove everything.
     */
    async removeDir(remoteDirPath: string): Promise<void> {
        await this.cd(remoteDirPath)
        await this.clearWorkingDir()
        // Remove the directory itself if we're not already on root.
        const workingDir = await this.pwd()
        if (workingDir !== "/") {
            await this.cdup()
            await this.removeEmptyDir(remoteDirPath)
        }
    }

    /**
     * Remove all files and directories in the working directory without removing
     * the working directory itself.
     */
    async clearWorkingDir(): Promise<void> {
        for (const file of await this.list()) {
            if (file.isDirectory) {
                await this.cd(file.name)
                await this.clearWorkingDir()
                await this.cdup()
                await this.removeEmptyDir(file.name)
            }
            else {
                await this.remove(file.name)
            }
        }
    }

    /**
     * Upload the contents of a local directory to the remote working directory.
     *
     * This will overwrite existing files with the same names and reuse existing directories.
     * Unrelated files and directories will remain untouched. You can optionally provide a `remoteDirPath`
     * to put the contents inside a directory which will be created if necessary including all
     * intermediate directories. If you did provide a remoteDirPath the working directory will stay
     * the same as before calling this method.
     *
     * @param localDirPath  Local path, e.g. "foo/bar" or "../test"
     * @param [remoteDirPath]  Remote path of a directory to upload to. Working directory if undefined.
     */
    async uploadDir(localDirPath: string, remoteDirPath?: string): Promise<void> {
        let userDir = ""
        if (remoteDirPath) {
            userDir = await this.pwd() // Remember the current working directory to switch back to after upload is done.
            await this.ensureDir(remoteDirPath)
        }
        await uploadDirContents(this, localDirPath)
        if (remoteDirPath) {
            await this.cd(userDir)
        }
    }

    /**
     * Download all files and directories of the working directory to a local directory.
     *
     * @param localDirPath  The local directory to download to.
     */
    async downloadDir(localDirPath: string): Promise<void> {
        await ensureLocalDirectory(localDirPath)
        for (const file of await this.list()) {
            const localPath = join(localDirPath, file.name)
            if (file.isDirectory) {
                await this.cd(file.name)
                await this.downloadDir(localPath)
                await this.cdup()
            }
            else {
                await this.download(localPath, file.name)
            }
        }
    }

    /**
     * Make sure a given remote path exists, creating all directories as necessary.
     * This function also changes the current working directory to the given path.
     */
    async ensureDir(remoteDirPath: string): Promise<void> {
        // If the remoteDirPath was absolute go to root directory.
        if (remoteDirPath.startsWith("/")) {
            await this.cd("/")
        }
        const names = remoteDirPath.split("/").filter(name => name !== "")
        for (const name of names) {
            await openDir(this, name)
        }
    }

    /**
     * Remove an empty directory, will fail if not empty.
     */
    async removeEmptyDir(path: string): Promise<FTPResponse> {
        const validPath = await this.protectWhitespace(path)
        return this.send(`RMD ${validPath}`)
    }

    /**
     * FTP servers can't handle filenames that have leading whitespace. This method transforms
     * a given path to fix that issue for most cases.
     */
    async protectWhitespace(path: string): Promise<string> {
        if (!path.startsWith(" ")) {
            return path
        }
        // Handle leading whitespace by prepending the absolute path:
        // " test.txt" while being in the root directory becomes "/ test.txt".
        const pwd = await this.pwd()
        const absolutePathPrefix = pwd.endsWith("/") ? pwd : pwd + "/"
        return absolutePathPrefix + path
    }
}

/**
 * Try all available transfer strategies and pick the first one that works. Update `client` to
 * use the working strategy for all successive transfer requests.
 *
 * @param strategies
 * @returns a function that will try the provided strategies.
 */
export function enterFirstCompatibleMode(strategies: TransferStrategy[], client: Client): TransferStrategy {
    return async function autoDetect(ftp) {
        ftp.log("Trying to find optimal transfer strategy...")
        for (const strategy of strategies) {
            try {
                const res = await strategy(ftp)
                ftp.log("Optimal transfer strategy found.")
                client.prepareTransfer = strategy // eslint-disable-line require-atomic-updates
                return res
            }
            catch(err) {
                // Receiving an FTPError means that the last transfer strategy failed and we should
                // try the next one. Any other exception should stop the evaluation of strategies because
                // something else went wrong.
                if (!(err instanceof FTPError)) {
                    throw err
                }
            }
        }
        throw new Error("None of the available transfer strategies work.")
    }
}

/**
 * Upload the contents of a local directory to the working directory. This will overwrite
 * existing files and reuse existing directories.
 */
async function uploadDirContents(client: Client, localDirPath: string): Promise<void> {
    const files = await fsReadDir(localDirPath)
    for (const file of files) {
        const fullPath = join(localDirPath, file)
        const stats = await fsStat(fullPath)
        if (stats.isFile()) {
            await client.upload(fullPath, file)
        }
        else if (stats.isDirectory()) {
            await openDir(client, file)
            await uploadDirContents(client, fullPath)
            await client.cdup()
        }
    }
}

/**
 * Try to create a directory and enter it. This will not raise an exception if the directory
 * couldn't be created if for example it already exists.
 */
async function openDir(client: Client, dirName: string) {
    await client.send("MKD " + dirName, true) // Ignore FTP error codes
    await client.cd(dirName)
}

async function ensureLocalDirectory(path: string) {
    try {
        await fsStat(path)
    }
    catch(err) {
        await fsMkDir(path)
    }
}

async function ignoreException(func: () => Promise<void>) {
    try {
        await func()
    }
    catch(err) {
        // Ignore
    }
}
