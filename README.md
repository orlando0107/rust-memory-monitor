# Rust Memory Monitor

![Rust Memory Monitor](resources/icon.svg)

Una extensión para Visual Studio Code que monitorea el uso de memoria en proyectos Rust, proporcionando información detallada sobre el consumo de memoria del sistema, del proyecto y de las variables.

[![GitHub](https://img.shields.io/badge/GitHub-Repository-blue?style=flat&logo=github)](https://github.com/orlando0107/rust-memory-monitor)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Características

- **Monitoreo en tiempo real** de la memoria del sistema y del proyecto Rust
- **Análisis detallado de variables** con información sobre:
  - Tipo de declaración (let, const, static, mut)
  - Tipo de dato
  - Tamaño estimado en memoria
  - Ubicación en el código
- **Indicadores visuales** con códigos de color:
  - Verde: uso de memoria bajo (< 50%)
  - Amarillo: uso de memoria medio (50-80%)
  - Rojo: uso de memoria alto (> 80%)
- **Estadísticas de memoria**:
  - Memoria física (RSS)
  - Memoria virtual
  - Memoria total estimada
  - Uso de CPU
- **Resumen de variables**:
  - Total de variables encontradas
  - Tamaño total estimado
  - Desglose por tipo de variable

## Requisitos

- Visual Studio Code 1.60.0 o superior
- Sistema operativo Linux (por el momento)
- Proyecto Rust con archivos `.rs`

## Instalación

### Desde VS Code Marketplace
1. Abre Visual Studio Code
2. Ve a la pestaña de extensiones (Ctrl+Shift+X)
3. Busca "Rust Memory Monitor"
4. Haz clic en "Instalar"

### Desde GitHub
1. Clona el repositorio:
   ```bash
   git clone https://github.com/orlando0107/rust-memory-monitor.git
   ```
2. Navega al directorio:
   ```bash
   cd rust-memory-monitor
   ```
3. Instala las dependencias:
   ```bash
   npm install
   ```
4. Compila la extensión:
   ```bash
   npm run compile
   ```
5. Empaqueta la extensión:
   ```bash
   vsce package
   ```
6. Instala el archivo .vsix generado en VS Code

## Uso

1. Abre un proyecto Rust en VS Code
2. Haz clic en el icono de Rust Memory Monitor en la barra de actividad
3. La extensión comenzará a monitorear automáticamente:
   - Memoria del sistema
   - Memoria del proyecto Rust
   - Variables y su uso de memoria

## Información mostrada

### Memoria del Proyecto Rust
- **Memoria Física (RSS)**: 
  - Es la memoria real que está usando tu proyecto en la RAM
  - Representa la cantidad actual de memoria física que el proceso está utilizando
  - Es la memoria que realmente está siendo usada por tu programa

- **Memoria Virtual (VSIZE)**:
  - Es el espacio de direcciones virtuales reservado para tu proceso
  - No necesariamente está siendo usado, es solo espacio reservado
  - El sistema operativo asigna este espacio virtual por adelantado
  - Es normal que sea mayor que la memoria física porque:
    - Incluye espacio para el código fuente
    - Reserva espacio para las herramientas de desarrollo
    - Permite que el programa crezca si es necesario
    - Incluye espacio para bibliotecas y dependencias

- **Memoria Total Estimada**: RSS + tamaño estimado de variables
- **% CPU**: Porcentaje de uso de CPU

### Memoria del Sistema
- Total: Memoria RAM total disponible
- Usada: Memoria RAM en uso
- Libre: Memoria RAM disponible

### Variables Rust
- Lista de variables con:
  - Nombre de la variable
  - Tipo de declaración (let/const/static/mut)
  - Tipo de dato
  - Tamaño estimado en bytes
  - Archivo donde se encuentra

## Tamaños estimados de tipos

La extensión estima el tamaño de las variables basándose en los tipos de datos comunes en Rust:

- `String` y `Vec`: 24 bytes
- `i32`, `u32`, `f32`: 4 bytes
- `i64`, `u64`, `f64`: 8 bytes
- `bool`: 1 byte
- `char`: 4 bytes
- `Option`: 24 bytes
- `Result`: 24 bytes
- Otros tipos: 8 bytes (estimación predeterminada)

## Contribuir

Las contribuciones son bienvenidas. Por favor, abre un issue para discutir los cambios que te gustaría hacer.

## Licencia

MIT License

Copyright (c) 2024 [OrlandoCV]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. 