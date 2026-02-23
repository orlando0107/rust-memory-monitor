import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

class MemoryMonitorProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'rustMemoryMonitorView';

    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Agregar manejador para abrir archivos
        const messageHandler = webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'openFile':
                        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                        const filePath = vscode.Uri.file(path.join(workspaceRoot, message.file));
                        vscode.workspace.openTextDocument(filePath).then(doc => {
                            vscode.window.showTextDocument(doc).then(editor => {
                                const position = new vscode.Position(message.line - 1, 0);
                                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                                editor.selection = new vscode.Selection(position, position);
                            });
                        });
                        break;
                }
            }
        );
        this._disposables.push(messageHandler);

        // Configurar el file watcher para archivos Rust
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(workspaceRoot, '**/*.rs')
            );

            // Actualizar cuando se crea, modifica o elimina un archivo
            watcher.onDidCreate(() => {
                console.log('Archivo Rust creado');
                this.updateMemoryInfo();
            });
            watcher.onDidChange(() => {
                console.log('Archivo Rust modificado');
                this.updateMemoryInfo();
            });
            watcher.onDidDelete(() => {
                console.log('Archivo Rust eliminado');
                this.updateMemoryInfo();
            });

            this._disposables.push(watcher);
        }

        // Observar cambios en el editor
        const editorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
            console.log('Editor activo cambiado');
            this.updateMemoryInfo();
        });
        this._disposables.push(editorWatcher);

        const documentWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.fileName.endsWith('.rs')) {
                console.log('Documento Rust modificado:', event.document.fileName);
                this.updateMemoryInfo();
            }
        });
        this._disposables.push(documentWatcher);

        // Actualizar cada 2 segundos
        setInterval(() => {
            this.updateMemoryInfo();
        }, 2000);

        // Actualización inicial
        this.updateMemoryInfo();
    }

    dispose() {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private formatMemorySize(kb: number): string {
        if (kb < 1024) {
            return `${kb.toFixed(2)} KB`;
        } else if (kb < 1024 * 1024) {
            return `${(kb / 1024).toFixed(2)} MB`;
        } else {
            return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
        }
    }

    private getUsageColor(percentage: number): string {
        if (percentage < 50) {
            return 'var(--vscode-terminal-ansiGreen)'; // Verde para uso bajo
        } else if (percentage < 80) {
            return 'var(--vscode-terminal-ansiYellow)'; // Amarillo para uso medio
        } else {
            return 'var(--vscode-terminal-ansiRed)'; // Rojo para uso alto
        }
    }

    private async analyzeRustVariables(workspaceRoot: string): Promise<{ totalSize: number, variables: any[], typeCounts: any }> {
        try {
            const rustFiles = this.findRustFilesSync(workspaceRoot);
            
            let totalSize = 0;
            const variables: any[] = [];
            const typeCounts: any = {};
            
            for (const file of rustFiles) {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split('\n');
                const relativePath = path.relative(workspaceRoot, file);
                
                // 1. Variables: let, const, static (excluir const fn)
                const varRegex = /(let|const|static)\s+(mut\s+)?(?!fn\b)([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*([a-zA-Z0-9_:<>[\],\s&']+))?/g;
                let match;
                
                while ((match = varRegex.exec(content)) !== null) {
                    const declarationType = match[1];
                    const isMut = match[2] ? true : false;
                    const varName = match[3];
                    const varType = match[4]?.trim() || 'inferido';
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) {
                        continue;
                    }
                    
                    const initMatch = lineContent.match(/=\s*(.+?)(?:;|$)/);
                    const initValue = initMatch ? initMatch[1].trim() : undefined;
                    
                    const estimated = this.estimateTypeSize(varType, initValue);
                    const totalEstimated = estimated.stack + estimated.heap;
                    
                    let fullDeclaration = declarationType;
                    if (isMut) {
                        fullDeclaration += ' mut';
                    }

                    // Detectar closures
                    if (initValue && /^(move\s*)?\|/.test(initValue)) {
                        fullDeclaration = 'closure';
                    }
                    
                    this.addToResults(variables, typeCounts, {
                        name: varName, declaration: fullDeclaration, type: varType,
                        stackSize: estimated.stack, heapSize: estimated.heap,
                        size: totalEstimated, file: relativePath, line: lineNumber
                    });
                    totalSize += totalEstimated;
                }

                // 2. Funciones: fn, pub fn, const fn, async fn, unsafe fn, extern "C" fn
                const fnRegex = /(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^\s{]+))?/g;
                while ((match = fnRegex.exec(content)) !== null) {
                    const fnName = match[1];
                    const params = match[2];
                    const returnType = match[3]?.trim() || '()';
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    const paramCount = params ? params.split(',').filter(p => p.trim() && !p.trim().startsWith('self')).length : 0;
                    const stackPerParam = 8;
                    const returnSize = this.estimateTypeSize(returnType).stack;
                    const fnStack = 8 + (paramCount * stackPerParam) + returnSize;

                    this.addToResults(variables, typeCounts, {
                        name: fnName, declaration: 'fn', type: `(${paramCount} params) -> ${returnType}`,
                        stackSize: fnStack, heapSize: 0,
                        size: fnStack, file: relativePath, line: lineNumber
                    });
                    totalSize += fnStack;
                }

                // 3. Structs
                const structRegex = /(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
                while ((match = structRegex.exec(content)) !== null) {
                    const structName = match[1];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    const structSize = this.estimateStructSize(content, match.index);

                    this.addToResults(variables, typeCounts, {
                        name: structName, declaration: 'struct', type: 'struct',
                        stackSize: structSize.stack, heapSize: structSize.heap,
                        size: structSize.stack + structSize.heap, file: relativePath, line: lineNumber
                    });
                    totalSize += structSize.stack + structSize.heap;
                }

                // 4. Enums
                const enumRegex = /(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
                while ((match = enumRegex.exec(content)) !== null) {
                    const enumName = match[1];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    const enumSize = this.estimateEnumSize(content, match.index);

                    this.addToResults(variables, typeCounts, {
                        name: enumName, declaration: 'enum', type: 'enum',
                        stackSize: enumSize, heapSize: 0,
                        size: enumSize, file: relativePath, line: lineNumber
                    });
                    totalSize += enumSize;
                }

                // 5. Traits
                const traitRegex = /(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
                while ((match = traitRegex.exec(content)) !== null) {
                    const traitName = match[1];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    this.addToResults(variables, typeCounts, {
                        name: traitName, declaration: 'trait', type: 'trait (vtable)',
                        stackSize: 16, heapSize: 0,
                        size: 16, file: relativePath, line: lineNumber
                    });
                    totalSize += 16;
                }

                // 6. Impl blocks: impl Name { ... }
                const implRegex = /impl(?:\s*<[^>]*>)?\s+(?:([a-zA-Z_][a-zA-Z0-9_:]*)\s+for\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/g;
                while ((match = implRegex.exec(content)) !== null) {
                    const traitImpl = match[1];
                    const targetName = match[2];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    const implLabel = traitImpl ? `impl ${traitImpl} for ${targetName}` : `impl ${targetName}`;

                    this.addToResults(variables, typeCounts, {
                        name: targetName, declaration: 'impl', type: implLabel,
                        stackSize: 0, heapSize: 0,
                        size: 0, file: relativePath, line: lineNumber
                    });
                }

                // 7. Type aliases: type Name = ...
                const typeRegex = /(?:pub\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*=\s*([^;]+)/g;
                while ((match = typeRegex.exec(content)) !== null) {
                    const typeName = match[1];
                    const aliasOf = match[2].trim();
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    const estimated = this.estimateTypeSize(aliasOf);

                    this.addToResults(variables, typeCounts, {
                        name: typeName, declaration: 'type', type: aliasOf,
                        stackSize: estimated.stack, heapSize: estimated.heap,
                        size: estimated.stack + estimated.heap, file: relativePath, line: lineNumber
                    });
                    totalSize += estimated.stack + estimated.heap;
                }

                // 8. Modules: mod name
                const modRegex = /(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
                while ((match = modRegex.exec(content)) !== null) {
                    const modName = match[1];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    this.addToResults(variables, typeCounts, {
                        name: modName, declaration: 'mod', type: 'module',
                        stackSize: 0, heapSize: 0,
                        size: 0, file: relativePath, line: lineNumber
                    });
                }

                // 9. Unions: union Name { fields... }
                const unionRegex = /(?:pub(?:\s*\([^)]*\))?\s+)?union\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
                while ((match = unionRegex.exec(content)) !== null) {
                    const unionName = match[1];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    const unionSize = this.estimateStructSize(content, match.index);

                    this.addToResults(variables, typeCounts, {
                        name: unionName, declaration: 'union', type: 'union',
                        stackSize: unionSize.stack, heapSize: unionSize.heap,
                        size: unionSize.stack + unionSize.heap, file: relativePath, line: lineNumber
                    });
                    totalSize += unionSize.stack + unionSize.heap;
                }

                // 10. Macros: macro_rules! name
                const macroRegex = /macro_rules!\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
                while ((match = macroRegex.exec(content)) !== null) {
                    const macroName = match[1];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    this.addToResults(variables, typeCounts, {
                        name: macroName, declaration: 'macro', type: 'macro_rules!',
                        stackSize: 0, heapSize: 0,
                        size: 0, file: relativePath, line: lineNumber
                    });
                }

                // 11. Use declarations: use path::to::item
                const useRegex = /(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+)/g;
                while ((match = useRegex.exec(content)) !== null) {
                    const usePath = match[1].trim();
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    const shortName = usePath.split('::').pop()?.replace(/[{}\s]/g, '') || usePath;

                    this.addToResults(variables, typeCounts, {
                        name: shortName, declaration: 'use', type: usePath,
                        stackSize: 0, heapSize: 0,
                        size: 0, file: relativePath, line: lineNumber
                    });
                }

                // 12. Extern crate: extern crate name
                const externCrateRegex = /extern\s+crate\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
                while ((match = externCrateRegex.exec(content)) !== null) {
                    const crateName = match[1];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    this.addToResults(variables, typeCounts, {
                        name: crateName, declaration: 'extern crate', type: 'crate',
                        stackSize: 0, heapSize: 0,
                        size: 0, file: relativePath, line: lineNumber
                    });
                }

                // 13. Extern blocks: extern "C" { ... }
                const externBlockRegex = /extern\s+"([^"]+)"\s*\{/g;
                while ((match = externBlockRegex.exec(content)) !== null) {
                    const abi = match[1];
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    const lineContent = lines[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) { continue; }

                    this.addToResults(variables, typeCounts, {
                        name: `extern "${abi}"`, declaration: 'extern', type: `ABI: ${abi}`,
                        stackSize: 0, heapSize: 0,
                        size: 0, file: relativePath, line: lineNumber
                    });
                }
            }
            
            return { totalSize, variables, typeCounts };
        } catch (error) {
            console.error('Error al analizar variables Rust:', error);
            return { totalSize: 0, variables: [], typeCounts: {} };
        }
    }

    private addToResults(variables: any[], typeCounts: any, item: any) {
        const typeKey = `${item.declaration}: ${item.type}`;
        if (!typeCounts[typeKey]) {
            typeCounts[typeKey] = { count: 0, totalSize: 0 };
        }
        typeCounts[typeKey].count++;
        typeCounts[typeKey].totalSize += item.size;
        variables.push(item);
    }

    private estimateStructSize(content: string, startIndex: number): { stack: number, heap: number } {
        const afterStruct = content.substring(startIndex);
        const braceMatch = afterStruct.match(/\{([^}]*)\}/);
        if (!braceMatch) return { stack: 0, heap: 0 };

        const fields = braceMatch[1].split(',').filter(f => f.trim());
        let stack = 0;
        let heap = 0;

        for (const field of fields) {
            const fieldMatch = field.trim().match(/(?:pub\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*(.+)/);
            if (fieldMatch) {
                const fieldType = fieldMatch[1].trim();
                const est = this.estimateTypeSize(fieldType);
                stack += est.stack;
                heap += est.heap;
            }
        }

        return { stack: stack || 8, heap };
    }

    private estimateEnumSize(content: string, startIndex: number): number {
        const afterEnum = content.substring(startIndex);
        const braceMatch = afterEnum.match(/\{([^}]*)\}/);
        if (!braceMatch) return 8;

        const variants = braceMatch[1].split(',').filter(v => v.trim());
        let maxSize = 0;

        for (const variant of variants) {
            const tupleMatch = variant.match(/\(([^)]+)\)/);
            if (tupleMatch) {
                const types = tupleMatch[1].split(',');
                let variantSize = 0;
                for (const t of types) {
                    variantSize += this.estimateTypeSize(t.trim()).stack;
                }
                maxSize = Math.max(maxSize, variantSize);
            } else {
                maxSize = Math.max(maxSize, 0);
            }
        }

        return 8 + maxSize; // discriminant (8) + largest variant
    }

    private estimateTypeSize(type: string, initValue?: string): { stack: number, heap: number } {
        // Tipos primitivos - solo stack, sin heap
        if (type.includes('i8') && !type.includes('i128')) return { stack: 1, heap: 0 };
        if (type.includes('u8') && !type.includes('u128')) return { stack: 1, heap: 0 };
        if (type.includes('i16')) return { stack: 2, heap: 0 };
        if (type.includes('u16')) return { stack: 2, heap: 0 };
        if (type.includes('i32')) return { stack: 4, heap: 0 };
        if (type.includes('u32')) return { stack: 4, heap: 0 };
        if (type.includes('f32')) return { stack: 4, heap: 0 };
        if (type.includes('i64')) return { stack: 8, heap: 0 };
        if (type.includes('u64')) return { stack: 8, heap: 0 };
        if (type.includes('f64')) return { stack: 8, heap: 0 };
        if (type.includes('i128')) return { stack: 16, heap: 0 };
        if (type.includes('u128')) return { stack: 16, heap: 0 };
        if (type.includes('isize')) return { stack: 8, heap: 0 };
        if (type.includes('usize')) return { stack: 8, heap: 0 };
        if (type.includes('bool')) return { stack: 1, heap: 0 };
        if (type.includes('char')) return { stack: 4, heap: 0 };

        // Referencias - solo puntero en stack
        if (type.includes('&str') || type.includes('&[u8]')) return { stack: 16, heap: 0 };
        if (type.includes('&')) return { stack: 8, heap: 0 };

        // String: 24 bytes stack (ptr + len + capacity) + heap para contenido
        if (type.includes('String')) {
            return { stack: 24, heap: this.estimateStringHeap(initValue) };
        }

        // Vec: 24 bytes stack + heap para elementos
        if (type.includes('Vec')) {
            return { stack: 24, heap: this.estimateVecHeap(type, initValue) };
        }

        // HashMap/BTreeMap: ~48 bytes stack + heap
        if (type.includes('HashMap') || type.includes('BTreeMap')) {
            return { stack: 48, heap: this.estimateCollectionHeap(initValue) };
        }

        // HashSet/BTreeSet
        if (type.includes('HashSet') || type.includes('BTreeSet')) {
            return { stack: 32, heap: this.estimateCollectionHeap(initValue) };
        }

        // Smart pointers - 8 bytes stack + contenido en heap
        if (type.includes('Box')) return { stack: 8, heap: 8 };
        if (type.includes('Arc') || type.includes('Rc')) return { stack: 8, heap: 24 };

        // Option/Result envuelven otro tipo
        if (type.includes('Option')) return { stack: 24, heap: 0 };
        if (type.includes('Result')) return { stack: 24, heap: 0 };

        // Arrays fijos
        if (type.includes('[u8;')) {
            const match = type.match(/\[u8;\s*(\d+)\]/);
            if (match) return { stack: parseInt(match[1]), heap: 0 };
            return { stack: 24, heap: 0 };
        }

        // Tipos personalizados (structs, enums) - estimación conservadora
        return { stack: 8, heap: 0 };
    }

    private estimateStringHeap(initValue?: string): number {
        if (!initValue) return 64;

        if (initValue.includes('String::new()')) return 0;

        const fromMatch = initValue.match(/String::from\(\s*"([^"]*)"\s*\)/);
        if (fromMatch) return fromMatch[1].length;

        const toStrMatch = initValue.match(/"([^"]*)"\.to_string\(\)/);
        if (toStrMatch) return toStrMatch[1].length;

        const capMatch = initValue.match(/String::with_capacity\(\s*(\d+)\s*\)/);
        if (capMatch) return parseInt(capMatch[1]);

        if (initValue.includes('format!')) return 128;
        if (initValue.includes('.to_owned()') || initValue.includes('.clone()')) return 64;

        return 64;
    }

    private estimateVecHeap(type: string, initValue?: string): number {
        const elemSize = this.guessVecElementSize(type);

        if (!initValue) return elemSize * 16;

        if (initValue.includes('Vec::new()')) return 0;

        const vecMacroMatch = initValue.match(/vec!\[([^\]]*)\]/);
        if (vecMacroMatch) {
            const content = vecMacroMatch[1].trim();
            if (!content) return 0;
            const repeatMatch = content.match(/(.+);\s*(\d+)/);
            if (repeatMatch) return parseInt(repeatMatch[2]) * elemSize;
            const elements = content.split(',').filter(e => e.trim());
            return elements.length * elemSize;
        }

        const capMatch = initValue.match(/Vec::with_capacity\(\s*(\d+)\s*\)/);
        if (capMatch) return parseInt(capMatch[1]) * elemSize;

        return elemSize * 16;
    }

    private guessVecElementSize(type: string): number {
        if (type.includes('Vec<u8>') || type.includes('Vec<i8>') || type.includes('Vec<bool>')) return 1;
        if (type.includes('Vec<u16>') || type.includes('Vec<i16>')) return 2;
        if (type.includes('Vec<u32>') || type.includes('Vec<i32>') || type.includes('Vec<f32>')) return 4;
        if (type.includes('Vec<u64>') || type.includes('Vec<i64>') || type.includes('Vec<f64>')) return 8;
        if (type.includes('Vec<String>')) return 24;
        return 8;
    }

    private estimateCollectionHeap(initValue?: string): number {
        if (!initValue) return 0;
        if (initValue.includes('::new()')) return 0;
        const capMatch = initValue.match(/with_capacity\(\s*(\d+)\s*\)/);
        if (capMatch) return parseInt(capMatch[1]) * 64;
        return 0;
    }

    private findRustFilesSync(dir: string): string[] {
        const results: string[] = [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (['target', '.cargo', 'node_modules', '.git'].includes(entry.name)) {
                        continue;
                    }
                    results.push(...this.findRustFilesSync(fullPath));
                } else if (entry.name.endsWith('.rs')) {
                    results.push(fullPath);
                }
            }
        } catch {
            // Ignorar errores de permisos
        }
        return results;
    }

    private getSystemMemoryInfo(): { total: number, used: number, free: number } {
        const totalKB = Math.round(os.totalmem() / 1024);
        const freeKB = Math.round(os.freemem() / 1024);
        const usedKB = totalKB - freeKB;
        return { total: totalKB, used: usedKB, free: freeKB };
    }

    private async getProcessMemoryInfo(): Promise<{ rss: number, vsize: number, pmem: string, pcpu: string } | null> {
        try {
            if (os.platform() === 'win32') {
                const psScript = `Get-Process | Where-Object { $_.Path -ne $null -and ($_.Path -match 'target\\\\debug' -or $_.Path -match 'target/debug') } | Select-Object -First 1 | ForEach-Object { "$($_.WorkingSet64) $($_.VirtualMemorySize64)" }`;
                const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
                const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`);
                if (!stdout.trim()) { return null; }
                const parts = stdout.trim().split(/\s+/);
                const rssKB = Math.round(parseInt(parts[0]) / 1024);
                const vsizeKB = Math.round(parseInt(parts[1]) / 1024);
                const totalSystemKB = Math.round(os.totalmem() / 1024);
                const pmem = ((rssKB / totalSystemKB) * 100).toFixed(1);
                return { rss: rssKB, vsize: vsizeKB, pmem, pcpu: '0' };
            } else {
                const { stdout } = await execAsync('ps -o rss,vsz,pmem,pcpu -p $(pgrep -f "target/debug")');
                const memoryInfo = stdout.split('\n')[1].trim().split(/\s+/);
                return {
                    rss: parseInt(memoryInfo[0]),
                    vsize: parseInt(memoryInfo[1]),
                    pmem: memoryInfo[2],
                    pcpu: memoryInfo[3]
                };
            }
        } catch {
            return null;
        }
    }

    private async updateMemoryInfo() {
        if (!this._view) {
            return;
        }

        try {
            console.log('Iniciando actualización de información de memoria...');
            
            // Obtener la raíz del workspace
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            
            // Analizar variables Rust primero
            const { totalSize, variables, typeCounts } = await this.analyzeRustVariables(workspaceRoot);
            
            // Obtener información de memoria del proceso Rust (cross-platform)
            const procInfo = await this.getProcessMemoryInfo();
            
            // Obtener información del sistema (cross-platform via os module)
            const sysInfo = this.getSystemMemoryInfo();
            
            // Calcular memoria total del proyecto (RSS + tamaño estimado de variables)
            const projectRSS = procInfo ? procInfo.rss : 0;
            const projectVsize = procInfo ? procInfo.vsize : 0;
            const projectTotalMemory = projectRSS + Math.ceil(totalSize / 1024);
            
            // Calcular porcentajes para colores
            const systemUsedPercentage = sysInfo.total > 0 ? (sysInfo.used / sysInfo.total) * 100 : 0;
            const processMemoryPercentage = sysInfo.total > 0 ? (projectRSS / sysInfo.total) * 100 : 0;
            
            console.log('Actualizando información de memoria:', {
                totalVariables: variables.length,
                totalSize,
                projectRSS,
                projectTotalMemory
            });

            const processRunning = procInfo !== null;

            this._view.webview.postMessage({
                type: 'updateMemory',
                data: {
                    processRunning,
                    processMemory: {
                        rss: this.formatMemorySize(projectRSS),
                        vsize: this.formatMemorySize(projectVsize),
                        pmem: procInfo ? procInfo.pmem : '0',
                        pcpu: procInfo ? procInfo.pcpu : '0',
                        total: this.formatMemorySize(projectTotalMemory),
                        percentage: processMemoryPercentage.toFixed(2),
                        color: this.getUsageColor(processMemoryPercentage)
                    },
                    systemMemory: {
                        total: this.formatMemorySize(sysInfo.total),
                        used: this.formatMemorySize(sysInfo.used),
                        free: this.formatMemorySize(sysInfo.free),
                        percentage: systemUsedPercentage.toFixed(2),
                        color: this.getUsageColor(systemUsedPercentage)
                    },
                    variablesInfo: {
                        totalCount: variables.length,
                        totalSize: totalSize,
                        typeCounts: Object.entries(typeCounts).map(([type, info]: [string, any]) => ({
                            type,
                            count: info.count,
                            totalSize: info.totalSize
                        }))
                    },
                    variables: variables
                }
            });
        } catch (error) {
            console.error('Error al obtener información de memoria:', error);
        }
    }

    private _getHtmlForWebview(_webview: vscode.Webview) {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Rust Memory Monitor</title>
                <style>
                    body {
                        padding: 10px;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                        color: var(--vscode-foreground);
                        font-size: 13px;
                    }
                    .memory-info {
                        margin: 10px 0;
                        padding: 15px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                    }
                    .memory-info h3 {
                        margin: 0 0 15px 0;
                        color: var(--vscode-foreground);
                        font-size: 14px;
                        font-weight: 600;
                    }
                    .memory-info p {
                        margin: 8px 0;
                        color: var(--vscode-foreground);
                        font-size: 12px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .section {
                        margin-bottom: 20px;
                        padding: 15px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                        background-color: var(--vscode-editor-background);
                    }
                    .section-title {
                        font-weight: 600;
                        margin-bottom: 12px;
                        color: var(--vscode-textLink-foreground);
                        font-size: 13px;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .section-title::before {
                        content: "📊";
                        font-size: 14px;
                    }
                    .variables-container {
                        width: 100%;
                        overflow-x: auto;
                        margin-top: 15px;
                        border-radius: 4px;
                        background-color: var(--vscode-editor-background);
                    }
                    .variables-table {
                        width: 100%;
                        min-width: 600px;
                        border-collapse: separate;
                        border-spacing: 0;
                        font-size: 12px;
                    }
                    .variables-table th {
                        position: sticky;
                        top: 0;
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        z-index: 1;
                        padding: 8px 12px;
                        text-align: left;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        user-select: none;
                        font-weight: 600;
                        font-size: 12px;
                    }
                    .variables-table td {
                        padding: 8px 12px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        font-size: 12px;
                    }
                    .variables-table tr:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .type-counts {
                        margin-top: 15px;
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                        gap: 10px;
                    }
                    .type-count-item {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 8px 12px;
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        border-radius: 4px;
                        font-size: 12px;
                    }
                    .highlight {
                        font-weight: 600;
                        color: var(--vscode-textLink-foreground);
                    }
                    .usage-bar {
                        width: 100%;
                        height: 8px;
                        background-color: var(--vscode-progressBar-background);
                        border-radius: 4px;
                        margin-top: 8px;
                        overflow: hidden;
                    }
                    .usage-bar-fill {
                        height: 100%;
                        border-radius: 4px;
                        transition: width 0.3s ease, background-color 0.3s ease;
                    }
                    .usage-label {
                        display: flex;
                        justify-content: space-between;
                        margin-top: 4px;
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                    }
                    .usage-value {
                        font-weight: 600;
                        color: var(--vscode-foreground);
                    }
                    .variable-link {
                        color: var(--vscode-textLink-foreground);
                        text-decoration: none;
                        cursor: pointer;
                        font-weight: 500;
                    }
                    .variable-link:hover {
                        text-decoration: underline;
                    }
                    .file-info {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        margin-top: 2px;
                    }
                    .search-container {
                        margin: 15px 0;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    }
                    .search-input {
                        flex: 1;
                        padding: 8px 12px;
                        border: 1px solid var(--vscode-input-border);
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border-radius: 4px;
                        font-size: 12px;
                        transition: border-color 0.2s ease;
                    }
                    .search-input:focus {
                        outline: none;
                        border-color: var(--vscode-focusBorder);
                    }
                    .search-input::placeholder {
                        color: var(--vscode-input-placeholderForeground);
                    }
                    .no-results {
                        text-align: center;
                        padding: 20px;
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                        font-size: 12px;
                    }
                    .stats-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                        gap: 15px;
                        margin-bottom: 15px;
                    }
                    .stat-item {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        padding: 12px;
                        border-radius: 4px;
                        text-align: center;
                    }
                    .stat-value {
                        font-size: 16px;
                        font-weight: 600;
                        color: var(--vscode-textLink-foreground);
                        margin-bottom: 4px;
                    }
                    .stat-label {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                    }
                    .no-process-msg {
                        padding: 12px;
                        background-color: var(--vscode-inputValidation-warningBackground);
                        border: 1px solid var(--vscode-inputValidation-warningBorder);
                        border-radius: 4px;
                        font-size: 12px;
                        line-height: 1.5;
                        color: var(--vscode-foreground);
                    }
                    .no-process-msg code {
                        background-color: var(--vscode-textCodeBlock-background);
                        padding: 2px 6px;
                        border-radius: 3px;
                        font-family: var(--vscode-editor-font-family);
                    }
                    .has-heap {
                        color: var(--vscode-terminal-ansiYellow);
                        font-weight: 600;
                    }
                    .estimate-note {
                        margin-top: 10px;
                        padding: 8px;
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        border-top: 1px solid var(--vscode-panel-border);
                    }
                    @media (max-width: 768px) {
                        .stats-grid {
                            grid-template-columns: 1fr;
                        }
                        .type-counts {
                            grid-template-columns: 1fr;
                        }
                        .variables-table {
                            min-width: 100%;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="memory-info">
                    <div class="section">
                        <div class="section-title">Memoria del Proyecto Rust</div>
                        <div id="processNoData" class="no-process-msg">
                            ⚠️ No se detectó un proceso Rust en ejecución.<br>
                            Ejecuta tu proyecto con <code>cargo run</code> para ver datos reales de memoria.
                        </div>
                        <div id="processData">
                            <div class="stats-grid">
                                <div class="stat-item">
                                    <div class="stat-value" id="processRss">-</div>
                                    <div class="stat-label">Memoria Física (RSS)</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value" id="processVsize">-</div>
                                    <div class="stat-label">Memoria Virtual</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value" id="processTotal">-</div>
                                    <div class="stat-label">Memoria Total</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value" id="processCpu">-%</div>
                                    <div class="stat-label">Uso de CPU</div>
                                </div>
                            </div>
                            
                            <div class="usage-bar">
                                <div id="processUsageBar" class="usage-bar-fill" style="width: 0%; background-color: var(--vscode-terminal-ansiGreen)"></div>
                            </div>
                            <div class="usage-label">
                                <span>Uso de Memoria del Proyecto</span>
                                <span id="processUsageValue" class="usage-value">0%</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-title">Memoria del Sistema</div>
                        <div class="stats-grid">
                            <div class="stat-item">
                                <div class="stat-value" id="systemTotal">-</div>
                                <div class="stat-label">Total</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-value" id="systemUsed">-</div>
                                <div class="stat-label">Usada</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-value" id="systemFree">-</div>
                                <div class="stat-label">Libre</div>
                            </div>
                        </div>
                        
                        <div class="usage-bar">
                            <div id="systemUsageBar" class="usage-bar-fill" style="width: 0%; background-color: var(--vscode-terminal-ansiGreen)"></div>
                        </div>
                        <div class="usage-label">
                            <span>Uso de Memoria del Sistema</span>
                            <span id="systemUsageValue" class="usage-value">0%</span>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-title">Variables Rust</div>
                        <div class="stats-grid">
                            <div class="stat-item">
                                <div class="stat-value" id="variablesCount">-</div>
                                <div class="stat-label">Total de Variables</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-value" id="variablesTotal">-</div>
                                <div class="stat-label">Memoria Estimada (stack + heap)</div>
                            </div>
                        </div>
                        
                        <div class="search-container">
                            <input type="text" 
                                   class="search-input" 
                                   placeholder="Buscar variables por nombre, tipo o archivo..." 
                                   id="variableSearch">
                        </div>
                        
                        <div class="type-counts" id="typeCounts">
                            <div class="type-count-item">
                                <span>Cargando tipos...</span>
                            </div>
                        </div>
                        
                        <div class="variables-container">
                            <table class="variables-table">
                                <thead>
                                    <tr>
                                        <th>Variable</th>
                                        <th>Tipo</th>
                                        <th>Stack</th>
                                        <th>Heap (est.)</th>
                                        <th>Total</th>
                                    </tr>
                                </thead>
                                <tbody id="variablesTableBody">
                                    <tr>
                                        <td colspan="5">Cargando...</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div class="estimate-note">
                            ℹ️ Los tamaños heap son estimaciones basadas en análisis estático del código fuente.
                        </div>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    let currentVariables = []; // Almacena todas las variables

                    // Función para filtrar variables
                    function filterVariables(searchTerm) {
                        const searchLower = searchTerm.toLowerCase();
                        return currentVariables.filter(variable => 
                            variable.name.toLowerCase().includes(searchLower) ||
                            variable.type.toLowerCase().includes(searchLower) ||
                            variable.file.toLowerCase().includes(searchLower) ||
                            variable.declaration.toLowerCase().includes(searchLower)
                        );
                    }

                    function formatBytes(bytes) {
                        if (bytes === 0) return '0 B';
                        if (bytes < 1024) return bytes + ' B';
                        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
                        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
                    }

                    // Función para actualizar la tabla
                    function updateVariablesTable(variables) {
                        const tableBody = document.getElementById('variablesTableBody');
                        tableBody.innerHTML = '';
                        
                        if (variables.length > 0) {
                            variables.forEach(variable => {
                                const row = document.createElement('tr');
                                const heapClass = variable.heapSize > 0 ? 'has-heap' : '';
                                row.innerHTML = \`
                                    <td>
                                        <a class="variable-link" data-file="\${variable.file}" data-line="\${variable.line}">\${variable.name}</a>
                                        <div class="file-info">\${variable.file}:\${variable.line}</div>
                                    </td>
                                    <td>\${variable.type}</td>
                                    <td>\${formatBytes(variable.stackSize)}</td>
                                    <td class="\${heapClass}">\${formatBytes(variable.heapSize)}</td>
                                    <td><strong>\${formatBytes(variable.size)}</strong></td>
                                \`;
                                tableBody.appendChild(row);
                            });

                            document.querySelectorAll('.variable-link').forEach(link => {
                                link.addEventListener('click', () => {
                                    const file = link.getAttribute('data-file');
                                    const line = parseInt(link.getAttribute('data-line'));
                                    vscode.postMessage({
                                        type: 'openFile',
                                        file: file,
                                        line: line
                                    });
                                });
                            });
                        } else {
                            const row = document.createElement('tr');
                            row.innerHTML = '<td colspan="5" class="no-results">No se encontraron variables que coincidan con la búsqueda</td>';
                            tableBody.appendChild(row);
                        }
                    }

                    // Agregar event listener para la búsqueda
                    document.getElementById('variableSearch').addEventListener('input', (e) => {
                        const searchTerm = e.target.value;
                        const filteredVariables = filterVariables(searchTerm);
                        updateVariablesTable(filteredVariables);
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateMemory':
                                // Mostrar/ocultar sección de proceso según si hay proceso corriendo
                                const processRunning = message.data.processRunning;
                                document.getElementById('processNoData').style.display = processRunning ? 'none' : 'block';
                                document.getElementById('processData').style.display = processRunning ? 'block' : 'none';

                                if (processRunning) {
                                    document.getElementById('processRss').textContent = message.data.processMemory.rss;
                                    document.getElementById('processVsize').textContent = message.data.processMemory.vsize;
                                    document.getElementById('processTotal').textContent = message.data.processMemory.total;
                                    document.getElementById('processCpu').textContent = message.data.processMemory.pcpu + '%';
                                }
                                
                                // Actualizar barra de uso del proceso
                                const processUsageBar = document.getElementById('processUsageBar');
                                processUsageBar.style.width = message.data.processMemory.percentage + '%';
                                processUsageBar.style.backgroundColor = message.data.processMemory.color;
                                document.getElementById('processUsageValue').textContent = message.data.processMemory.percentage + '%';
                                
                                // Actualizar información del sistema
                                document.getElementById('systemTotal').textContent = message.data.systemMemory.total;
                                document.getElementById('systemUsed').textContent = message.data.systemMemory.used;
                                document.getElementById('systemFree').textContent = message.data.systemMemory.free;
                                
                                // Actualizar barra de uso del sistema
                                const systemUsageBar = document.getElementById('systemUsageBar');
                                systemUsageBar.style.width = message.data.systemMemory.percentage + '%';
                                systemUsageBar.style.backgroundColor = message.data.systemMemory.color;
                                document.getElementById('systemUsageValue').textContent = message.data.systemMemory.percentage + '%';
                                
                                // Actualizar información de variables
                                document.getElementById('variablesCount').textContent = message.data.variablesInfo.totalCount;
                                document.getElementById('variablesTotal').textContent = formatBytes(message.data.variablesInfo.totalSize);
                                
                                // Actualizar conteo de tipos
                                const typeCountsContainer = document.getElementById('typeCounts');
                                typeCountsContainer.innerHTML = '';
                                
                                if (message.data.variablesInfo.typeCounts && message.data.variablesInfo.typeCounts.length > 0) {
                                    message.data.variablesInfo.typeCounts.forEach(typeInfo => {
                                        const typeItem = document.createElement('div');
                                        typeItem.className = 'type-count-item';
                                        typeItem.innerHTML = \`
                                        <span>\${typeInfo.type} (\${typeInfo.count})</span>
                                        <span>\${formatBytes(typeInfo.totalSize)}</span>
                                        \`;
                                        typeCountsContainer.appendChild(typeItem);
                                    });
                                } else {
                                    const noTypesItem = document.createElement('div');
                                    noTypesItem.className = 'type-count-item';
                                    noTypesItem.textContent = 'No se encontraron tipos';
                                    typeCountsContainer.appendChild(noTypesItem);
                                }
                                
                                // Actualizar variables
                                currentVariables = message.data.variables;
                                const searchTerm = document.getElementById('variableSearch').value;
                                const filteredVariables = filterVariables(searchTerm);
                                updateVariablesTable(filteredVariables);
                                break;
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new MemoryMonitorProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MemoryMonitorProvider.viewType, provider)
    );

    const disposable = vscode.commands.registerCommand('rust-memory-monitor.startMonitoring', () => {
        vscode.window.showInformationMessage('Monitor de memoria iniciado!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {} 