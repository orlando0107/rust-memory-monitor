import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

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
        context: vscode.WebviewViewResolveContext,
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

        // Actualizar cada 5 segundos
        setInterval(() => {
            this.updateMemoryInfo();
        }, 5000);
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
            // Buscar archivos Rust en el proyecto, excluyendo target y dependencias
            const { stdout } = await execAsync(`find ${workspaceRoot} -name "*.rs" | grep -v "target" | grep -v "Cargo.lock" | grep -v ".cargo"`);
            const rustFiles = stdout.split('\n').filter(file => file.trim() !== '');
            
            let totalSize = 0;
            const variables: any[] = [];
            const typeCounts: any = {};
            
            // Analizar cada archivo Rust
            for (const file of rustFiles) {
                const content = fs.readFileSync(file, 'utf8');
                const relativePath = path.relative(workspaceRoot, file);
                
                // Buscar declaraciones de variables con más detalle
                const varRegex = /(let|const|static|mut)\s+(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*([a-zA-Z0-9_:<>[\],\s]+))?/g;
                let match;
                
                while ((match = varRegex.exec(content)) !== null) {
                    const declarationType = match[1]; // let, const, static, mut
                    const varName = match[2];
                    const varType = match[3]?.trim() || 'inferido';
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    
                    // Estimar tamaño basado en el tipo
                    let estimatedSize = this.estimateTypeSize(varType);
                    
                    // Contar tipos de variables
                    const typeKey = `${declarationType} ${varType}`;
                    if (!typeCounts[typeKey]) {
                        typeCounts[typeKey] = { count: 0, totalSize: 0 };
                    }
                    typeCounts[typeKey].count++;
                    typeCounts[typeKey].totalSize += estimatedSize;
                    
                    // Agregar al total solo si es una variable que probablemente esté en memoria
                    if (declarationType !== 'const') {
                        totalSize += estimatedSize;
                    }
                    
                    variables.push({
                        name: varName,
                        declaration: declarationType,
                        type: varType,
                        size: estimatedSize,
                        file: relativePath,
                        line: lineNumber
                    });
                }
            }
            
            return { totalSize, variables, typeCounts };
        } catch (error) {
            console.error('Error al analizar variables Rust:', error);
            return { totalSize: 0, variables: [], typeCounts: {} };
        }
    }

    private estimateTypeSize(type: string): number {
        // Tipos enteros con signo
        if (type.includes('i8')) return 1;
        if (type.includes('i16')) return 2;
        if (type.includes('i32')) return 4;
        if (type.includes('i64')) return 8;
        if (type.includes('i128')) return 16;
        if (type.includes('isize')) return 8; // En sistemas de 64 bits

        // Tipos enteros sin signo
        if (type.includes('u8')) return 1;
        if (type.includes('u16')) return 2;
        if (type.includes('u32')) return 4;
        if (type.includes('u64')) return 8;
        if (type.includes('u128')) return 16;
        if (type.includes('usize')) return 8; // En sistemas de 64 bits

        // Tipos de punto flotante
        if (type.includes('f32')) return 4;
        if (type.includes('f64')) return 8;

        // Tipos booleanos y caracteres
        if (type.includes('bool')) return 1;
        if (type.includes('char')) return 4;

        // Tipos de punteros y referencias
        if (type.includes('&str') || type.includes('&[u8]')) return 16;
        if (type.includes('Box')) return 8;
        if (type.includes('&')) return 8; // Referencias son punteros

        // Tipos compuestos
        if (type.includes('String')) return 24;
        if (type.includes('Vec')) return 24;
        if (type.includes('Option')) return 24;
        if (type.includes('Result')) return 24;
        if (type.includes('[u8;')) {
            // Extraer el tamaño del array si está especificado
            const match = type.match(/\[u8;(\d+)\]/);
            if (match) {
                return parseInt(match[1]);
            }
            return 24;
        }

        // Tipos personalizados (structs, enums)
        // Por ahora usamos un tamaño predeterminado
        return 8;
    }

    private async updateMemoryInfo() {
        if (!this._view) {
            return;
        }

        try {
            // Obtener información de memoria del proceso Rust
            const { stdout } = await execAsync('ps -o rss,vsize,pmem,pcpu -p $(pgrep -f "target/debug")');
            const memoryInfo = stdout.split('\n')[1].trim().split(/\s+/);
            
            // Obtener la raíz del workspace
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            
            // Analizar variables Rust
            const { totalSize, variables, typeCounts } = await this.analyzeRustVariables(workspaceRoot);
            
            // Obtener información del sistema
            const { stdout: freeInfo } = await execAsync('free -k');
            const freeLines = freeInfo.split('\n');
            const memInfo = freeLines[1].trim().split(/\s+/);
            
            // Calcular memoria total del proyecto (RSS + tamaño estimado de variables)
            const projectRSS = parseInt(memoryInfo[0]);
            const projectTotalMemory = projectRSS + Math.ceil(totalSize / 1024); // Convertir bytes a KB
            
            // Calcular porcentajes para colores
            const systemUsedPercentage = (parseInt(memInfo[2]) / parseInt(memInfo[1])) * 100;
            const processMemoryPercentage = (projectRSS / parseInt(memInfo[1])) * 100;
            
            this._view.webview.postMessage({
                type: 'updateMemory',
                data: {
                    // Memoria del proceso Rust
                    processMemory: {
                        rss: this.formatMemorySize(parseInt(memoryInfo[0])),
                        vsize: this.formatMemorySize(parseInt(memoryInfo[1])),
                        pmem: memoryInfo[2],
                        pcpu: memoryInfo[3],
                        total: this.formatMemorySize(projectTotalMemory),
                        percentage: processMemoryPercentage.toFixed(2),
                        color: this.getUsageColor(processMemoryPercentage)
                    },
                    // Memoria del sistema
                    systemMemory: {
                        total: this.formatMemorySize(parseInt(memInfo[1])),
                        used: this.formatMemorySize(parseInt(memInfo[2])),
                        free: this.formatMemorySize(parseInt(memInfo[3])),
                        percentage: systemUsedPercentage.toFixed(2),
                        color: this.getUsageColor(systemUsedPercentage)
                    },
                    // Información de variables
                    variablesInfo: {
                        totalCount: variables.length,
                        totalSize: totalSize, // Enviar el tamaño en bytes
                        typeCounts: Object.entries(typeCounts).map(([type, info]: [string, any]) => ({
                            type,
                            count: info.count,
                            totalSize: info.totalSize // Enviar el tamaño en bytes
                        }))
                    },
                    // Lista de variables - ahora sin límite
                    variables: variables
                }
            });
        } catch (error) {
            console.error('Error al obtener información de memoria:', error);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
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
                    }
                    .memory-info {
                        margin: 10px 0;
                        padding: 10px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                    }
                    .memory-info h3 {
                        margin: 0 0 10px 0;
                        color: var(--vscode-foreground);
                        font-size: 14px;
                        font-weight: 600;
                    }
                    .memory-info p {
                        margin: 5px 0;
                        color: var(--vscode-foreground);
                        font-size: 12px;
                    }
                    .section {
                        margin-bottom: 15px;
                        padding: 10px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                    }
                    .section-title {
                        font-weight: 600;
                        margin-bottom: 8px;
                        color: var(--vscode-textLink-foreground);
                    }
                    .variables-container {
                        width: 100%;
                        overflow-x: auto;
                        margin-top: 10px;
                    }
                    .variables-table {
                        width: 100%;
                        min-width: 600px; /* Reducido el ancho mínimo */
                        border-collapse: separate;
                        border-spacing: 0;
                        font-size: 12px;
                    }
                    .variables-table th {
                        position: sticky;
                        top: 0;
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        z-index: 1;
                        padding: 4px 8px;
                        text-align: left;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        user-select: none;
                    }
                    .variables-table td {
                        padding: 4px 8px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    .resizer {
                        position: absolute;
                        top: 0;
                        right: 0;
                        width: 5px;
                        height: 100%;
                        background: var(--vscode-panel-border);
                        cursor: col-resize;
                    }
                    .resizer:hover {
                        background: var(--vscode-focusBorder);
                    }
                    .th-content {
                        position: relative;
                        padding-right: 15px; /* Espacio para el resizer */
                    }
                    .type-counts {
                        margin-top: 10px;
                    }
                    .type-count-item {
                        display: flex;
                        justify-content: space-between;
                        margin-bottom: 4px;
                        font-size: 12px;
                    }
                    .highlight {
                        font-weight: 600;
                    }
                    .usage-bar {
                        width: 100%;
                        height: 8px;
                        background-color: var(--vscode-progressBar-background);
                        border-radius: 4px;
                        margin-top: 5px;
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
                        margin-top: 2px;
                        font-size: 10px;
                    }
                    .usage-value {
                        font-weight: 600;
                    }
                    .variable-link {
                        color: var(--vscode-textLink-foreground);
                        text-decoration: none;
                        cursor: pointer;
                    }
                    .variable-link:hover {
                        text-decoration: underline;
                    }
                    .file-info {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                    }
                    .search-container {
                        margin: 10px 0;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    }
                    .search-input {
                        flex: 1;
                        padding: 6px 10px;
                        border: 1px solid var(--vscode-input-border);
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border-radius: 4px;
                        font-size: 12px;
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
                    }
                </style>
            </head>
            <body>
                <div class="memory-info">
                    <div class="section">
                        <div class="section-title">Memoria del Proyecto Rust</div>
                        <p>Memoria Física (RSS): <span id="processRss" class="highlight">-</span></p>
                        <p>Memoria Virtual: <span id="processVsize" class="highlight">-</span></p>
                        <p>Memoria Total Estimada: <span id="processTotal" class="highlight">-</span></p>
                        <p>% CPU: <span id="processCpu" class="highlight">-</span>%</p>
                        
                        <div class="usage-bar">
                            <div id="processUsageBar" class="usage-bar-fill" style="width: 0%; background-color: var(--vscode-terminal-ansiGreen)"></div>
                        </div>
                        <div class="usage-label">
                            <span>Uso de Memoria del Proyecto</span>
                            <span id="processUsageValue" class="usage-value">0%</span>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-title">Memoria del Sistema</div>
                        <p>Total: <span id="systemTotal" class="highlight">-</span></p>
                        <p>Usada: <span id="systemUsed" class="highlight">-</span></p>
                        <p>Libre: <span id="systemFree" class="highlight">-</span></p>
                        
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
                        <p>Total de Variables: <span id="variablesCount" class="highlight">-</span></p>
                        <p>Tamaño Total Estimado: <span id="variablesTotal" class="highlight">-</span></p>
                        
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
                                        <th><div class="th-content">Variable</div><div class="resizer"></div></th>
                                        <th><div class="th-content">Declaración</div><div class="resizer"></div></th>
                                        <th><div class="th-content">Tipo</div><div class="resizer"></div></th>
                                        <th><div class="th-content">Tamaño</div><div class="resizer"></div></th>
                                    </tr>
                                </thead>
                                <tbody id="variablesTableBody">
                                    <tr>
                                        <td colspan="4">Cargando...</td>
                                    </tr>
                                </tbody>
                            </table>
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

                    // Función para actualizar la tabla
                    function updateVariablesTable(variables) {
                        const tableBody = document.getElementById('variablesTableBody');
                        tableBody.innerHTML = '';
                        
                        if (variables.length > 0) {
                            variables.forEach(variable => {
                                const row = document.createElement('tr');
                                row.innerHTML = \`
                                    <td>
                                        <a class="variable-link" data-file="\${variable.file}" data-line="\${variable.line}">\${variable.name}</a>
                                        <div class="file-info">\${variable.file}:\${variable.line}</div>
                                    </td>
                                    <td>\${variable.declaration}</td>
                                    <td>\${variable.type}</td>
                                    <td>\${variable.size} bytes</td>
                                \`;
                                tableBody.appendChild(row);
                            });

                            // Agregar event listeners para los enlaces
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
                            row.innerHTML = '<td colspan="4" class="no-results">No se encontraron variables que coincidan con la búsqueda</td>';
                            tableBody.appendChild(row);
                        }

                        // Inicializar resizers después de actualizar la tabla
                        initializeResizers();
                    }

                    // Agregar event listener para la búsqueda
                    document.getElementById('variableSearch').addEventListener('input', (e) => {
                        const searchTerm = e.target.value;
                        const filteredVariables = filterVariables(searchTerm);
                        updateVariablesTable(filteredVariables);
                    });

                    // Agregar funcionalidad de redimensionamiento
                    function initializeResizers() {
                        const resizers = document.querySelectorAll('.resizer');
                        resizers.forEach(resizer => {
                            let x = 0;
                            let w = 0;

                            const mouseDownHandler = (e) => {
                                x = e.clientX;
                                const th = resizer.parentElement;
                                w = th.offsetWidth;
                                
                                document.addEventListener('mousemove', mouseMoveHandler);
                                document.addEventListener('mouseup', mouseUpHandler);
                            };

                            const mouseMoveHandler = (e) => {
                                const dx = e.clientX - x;
                                const th = resizer.parentElement;
                                th.style.width = \`\${w + dx}px\`;
                            };

                            const mouseUpHandler = () => {
                                document.removeEventListener('mousemove', mouseMoveHandler);
                                document.removeEventListener('mouseup', mouseUpHandler);
                            };

                            resizer.addEventListener('mousedown', mouseDownHandler);
                        });
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateMemory':
                                // Actualizar información de memoria del proceso
                                document.getElementById('processRss').textContent = message.data.processMemory.rss;
                                document.getElementById('processVsize').textContent = message.data.processMemory.vsize;
                                document.getElementById('processTotal').textContent = message.data.processMemory.total;
                                document.getElementById('processCpu').textContent = message.data.processMemory.pcpu;
                                
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
                                document.getElementById('variablesTotal').textContent = message.data.variablesInfo.totalSize + ' bytes';
                                
                                // Actualizar conteo de tipos
                                const typeCountsContainer = document.getElementById('typeCounts');
                                typeCountsContainer.innerHTML = '';
                                
                                if (message.data.variablesInfo.typeCounts && message.data.variablesInfo.typeCounts.length > 0) {
                                    message.data.variablesInfo.typeCounts.forEach(typeInfo => {
                                        const typeItem = document.createElement('div');
                                        typeItem.className = 'type-count-item';
                                        typeItem.innerHTML = \`
                                            <span>\${typeInfo.type} (\${typeInfo.count})</span>
                                            <span>\${typeInfo.totalSize} bytes</span>
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

    let disposable = vscode.commands.registerCommand('rust-memory-monitor.startMonitoring', () => {
        vscode.window.showInformationMessage('Monitor de memoria iniciado!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {} 