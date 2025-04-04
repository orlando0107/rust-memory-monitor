import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

class MemoryMonitorProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'rustMemoryMonitorView';

    private _view?: vscode.WebviewView;

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

        // Actualizar cada 5 segundos
        setInterval(() => {
            this.updateMemoryInfo();
        }, 5000);
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
            // Buscar archivos Rust en el proyecto
            const { stdout } = await execAsync(`find ${workspaceRoot} -name "*.rs" | grep -v "target"`);
            const rustFiles = stdout.split('\n').filter(file => file.trim() !== '');
            
            let totalSize = 0;
            const variables: any[] = [];
            const typeCounts: any = {};
            
            // Analizar cada archivo Rust
            for (const file of rustFiles) {
                const content = fs.readFileSync(file, 'utf8');
                
                // Buscar declaraciones de variables con más detalle
                const varRegex = /(let|const|static|mut)\s+(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*([a-zA-Z0-9_:<>[\],\s]+))?/g;
                let match;
                
                while ((match = varRegex.exec(content)) !== null) {
                    const declarationType = match[1]; // let, const, static, mut
                    const varName = match[2];
                    const varType = match[3]?.trim() || 'inferido';
                    
                    // Estimar tamaño basado en el tipo
                    let estimatedSize = 0;
                    
                    if (varType.includes('String') || varType.includes('Vec')) {
                        estimatedSize = 24; // Tamaño base para String y Vec
                    } else if (varType.includes('i32') || varType.includes('u32') || varType.includes('f32')) {
                        estimatedSize = 4;
                    } else if (varType.includes('i64') || varType.includes('u64') || varType.includes('f64')) {
                        estimatedSize = 8;
                    } else if (varType.includes('bool')) {
                        estimatedSize = 1;
                    } else if (varType.includes('char')) {
                        estimatedSize = 4;
                    } else if (varType.includes('Option')) {
                        estimatedSize = 24; // Tamaño para Option
                    } else if (varType.includes('Result')) {
                        estimatedSize = 24; // Tamaño para Result
                    } else {
                        estimatedSize = 8; // Tamaño predeterminado
                    }
                    
                    totalSize += estimatedSize;
                    
                    // Contar tipos de variables
                    const typeKey = `${declarationType} ${varType}`;
                    if (!typeCounts[typeKey]) {
                        typeCounts[typeKey] = { count: 0, totalSize: 0 };
                    }
                    typeCounts[typeKey].count++;
                    typeCounts[typeKey].totalSize += estimatedSize;
                    
                    variables.push({
                        name: varName,
                        declaration: declarationType,
                        type: varType,
                        size: estimatedSize,
                        file: path.relative(workspaceRoot, file)
                    });
                }
            }
            
            return { totalSize, variables, typeCounts };
        } catch (error) {
            console.error('Error al analizar variables Rust:', error);
            return { totalSize: 0, variables: [], typeCounts: {} };
        }
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
                        totalSize: this.formatMemorySize(Math.ceil(totalSize / 1024)), // Convertir bytes a KB
                        typeCounts: Object.entries(typeCounts).map(([type, info]: [string, any]) => ({
                            type,
                            count: info.count,
                            totalSize: this.formatMemorySize(Math.ceil(info.totalSize / 1024)) // Convertir bytes a KB
                        }))
                    },
                    // Lista de variables
                    variables: variables.slice(0, 10) // Limitar a 10 variables para no sobrecargar
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
                    .variables-table {
                        width: 100%;
                        border-collapse: collapse;
                        margin-top: 10px;
                        font-size: 12px;
                    }
                    .variables-table th, .variables-table td {
                        border: 1px solid var(--vscode-panel-border);
                        padding: 4px;
                        text-align: left;
                    }
                    .variables-table th {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
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
                        
                        <div class="type-counts" id="typeCounts">
                            <div class="type-count-item">
                                <span>Cargando tipos...</span>
                            </div>
                        </div>
                        
                        <table class="variables-table">
                            <thead>
                                <tr>
                                    <th>Variable</th>
                                    <th>Declaración</th>
                                    <th>Tipo</th>
                                    <th>Tamaño</th>
                                    <th>Archivo</th>
                                </tr>
                            </thead>
                            <tbody id="variablesTableBody">
                                <tr>
                                    <td colspan="5">Cargando...</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
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
                                document.getElementById('variablesTotal').textContent = message.data.variablesInfo.totalSize;
                                
                                // Actualizar conteo de tipos
                                const typeCountsContainer = document.getElementById('typeCounts');
                                typeCountsContainer.innerHTML = '';
                                
                                if (message.data.variablesInfo.typeCounts && message.data.variablesInfo.typeCounts.length > 0) {
                                    message.data.variablesInfo.typeCounts.forEach(typeInfo => {
                                        const typeItem = document.createElement('div');
                                        typeItem.className = 'type-count-item';
                                        typeItem.innerHTML = \`
                                            <span>\${typeInfo.type} (\${typeInfo.count})</span>
                                            <span>\${typeInfo.totalSize}</span>
                                        \`;
                                        typeCountsContainer.appendChild(typeItem);
                                    });
                                } else {
                                    const noTypesItem = document.createElement('div');
                                    noTypesItem.className = 'type-count-item';
                                    noTypesItem.textContent = 'No se encontraron tipos';
                                    typeCountsContainer.appendChild(noTypesItem);
                                }
                                
                                // Actualizar tabla de variables
                                const tableBody = document.getElementById('variablesTableBody');
                                tableBody.innerHTML = '';
                                
                                if (message.data.variables && message.data.variables.length > 0) {
                                    message.data.variables.forEach(variable => {
                                        const row = document.createElement('tr');
                                        row.innerHTML = \`
                                            <td>\${variable.name}</td>
                                            <td>\${variable.declaration}</td>
                                            <td>\${variable.type}</td>
                                            <td>\${variable.size} bytes</td>
                                            <td>\${variable.file}</td>
                                        \`;
                                        tableBody.appendChild(row);
                                    });
                                } else {
                                    const row = document.createElement('tr');
                                    row.innerHTML = '<td colspan="5">No se encontraron variables</td>';
                                    tableBody.appendChild(row);
                                }
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