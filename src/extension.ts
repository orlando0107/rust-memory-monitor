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
                const varRegex = /(let|const|static)\s+(mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*([a-zA-Z0-9_:<>[\],\s]+))?/g;
                let match;
                
                while ((match = varRegex.exec(content)) !== null) {
                    const declarationType = match[1]; // let, const, static
                    const isMut = match[2] ? true : false; // Verifica si tiene mut
                    const varName = match[3];
                    const varType = match[4]?.trim() || 'inferido';
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    
                    // Verificar si la variable está comentada
                    const lineContent = content.split('\n')[lineNumber - 1];
                    if (lineContent.trim().startsWith('//')) {
                        continue; // Ignorar variables comentadas
                    }
                    
                    // Estimar tamaño basado en el tipo
                    let estimatedSize = this.estimateTypeSize(varType);
                    
                    // Contar tipos de variables
                    const typeKey = `${varType}`;
                    if (!typeCounts[typeKey]) {
                        typeCounts[typeKey] = { count: 0, totalSize: 0 };
                    }
                    typeCounts[typeKey].count++;
                    typeCounts[typeKey].totalSize += estimatedSize;
                    
                    // Agregar al total
                    totalSize += estimatedSize;
                    
                    // Determinar el tipo de declaración completo
                    let fullDeclaration = declarationType;
                    if (isMut) {
                        fullDeclaration += ' mut';
                    }
                    
                    variables.push({
                        name: varName,
                        declaration: fullDeclaration,
                        type: varType,
                        size: estimatedSize,
                        file: relativePath,
                        line: lineNumber
                    });
                }
            }
            
            console.log('Análisis de variables completado:', {
                archivosAnalizados: rustFiles.length,
                variablesEncontradas: variables.length,
                tamañoTotal: totalSize
            });
            
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
            console.log('Iniciando actualización de información de memoria...');
            
            // Obtener la raíz del workspace
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            
            // Analizar variables Rust primero
            const { totalSize, variables, typeCounts } = await this.analyzeRustVariables(workspaceRoot);
            
            // Obtener información de memoria del proceso Rust
            const { stdout } = await execAsync('ps -o rss,vsize,pmem,pcpu -p $(pgrep -f "target/debug")');
            const memoryInfo = stdout.split('\n')[1].trim().split(/\s+/);
            
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
            
            console.log('Actualizando información de memoria:', {
                totalVariables: variables.length,
                totalSize,
                projectRSS,
                projectTotalMemory
            });

            this._view.webview.postMessage({
                type: 'updateMemory',
                data: {
                    processMemory: {
                        rss: this.formatMemorySize(parseInt(memoryInfo[0])),
                        vsize: this.formatMemorySize(parseInt(memoryInfo[1])),
                        pmem: memoryInfo[2],
                        pcpu: memoryInfo[3],
                        total: this.formatMemorySize(projectTotalMemory),
                        percentage: processMemoryPercentage.toFixed(2),
                        color: this.getUsageColor(processMemoryPercentage)
                    },
                    systemMemory: {
                        total: this.formatMemorySize(parseInt(memInfo[1])),
                        used: this.formatMemorySize(parseInt(memInfo[2])),
                        free: this.formatMemorySize(parseInt(memInfo[3])),
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
                                <div class="stat-label">Tamaño Total</div>
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
                                        <th>Declaración</th>
                                        <th>Tipo</th>
                                        <th>Tamaño</th>
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
                                // Actualizar información de memoria del proceso
                                document.getElementById('processRss').textContent = message.data.processMemory.rss;
                                document.getElementById('processVsize').textContent = message.data.processMemory.vsize;
                                document.getElementById('processTotal').textContent = message.data.processMemory.total;
                                document.getElementById('processCpu').textContent = message.data.processMemory.pcpu + '%';
                                
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