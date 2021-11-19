# Paynal

Deploys files over FTP or SFTP

*Paynal is an aztec god, who served as a representative of Huitzilopochtli.*

## Usage

- Create the [config file](#config-file)

- Run `npx paynal [<env>]`

- Enjoy :)

## Config file

The config file need to be named "paynal.config.js"  
You can setup it however you want (ES6-compliant) exporting a default object structured as `Config` interface
```ts
interface DSTObject {
    // the remote path
    path: string
    // any file to be added as source
    add?: string | string[]
    // any file to be skipped from source
    skip?: string | string[]
    // name or array of name of required destinations
    // to be deployed before this one
    requires?: string | string[]
}

interface FTPClient {
    exec(cmd: string, mirrorOutput: boolean = false): Promise<{
        code: number,
        signal?: number,
        stdout: string,
        stderr: string
    }>
    mkdir(path: string): Promise<boolean>
    put(local, remote): Promise<boolean>
    stat(path): Promise<any>
}

interface Plugin {
    name: string
    // called before any deploy
    pre?(dst: DSTObject, connection: FTPClient): any | Promise<any>
    // called after any deploy
    post?(dst: DSTObject, connection: FTPClient): any | Promise<any>
    // called after all deploy
    done?(): any | Promise<any>
    // called after any error in plugins
    error?(e): any | Promise<any>
}

// the default exported config object interface
interface Config {
    // connection config
    connection: {
        host: string,
        username: string,
        password: string,
        readyTimeout?: number
    }
    // source file(s)
    src: string | string[]
    // destination configs
    dst: {
        // a remote path or a config object
        [key: string]: string || DSTObject
    }
    // list of plugin to run on deploy events
    plugins?: Plugin[]
}
```
