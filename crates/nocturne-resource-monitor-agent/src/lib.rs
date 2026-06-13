use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceMetricKind {
    Cpu,
    Memory,
    Swap,
    Gpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetOs {
    Linux,
    Macos,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetArch {
    X86_64,
    Aarch64,
    Armv7,
    I686,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceMonitorAgentMetricStatus {
    Available,
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResourceMonitorAgentEvent {
    Hello {
        version: String,
        os: TargetOs,
        arch: TargetArch,
        capabilities: Vec<String>,
    },
    Snapshot {
        metrics: Vec<ResourceMonitorAgentMetric>,
    },
}

#[derive(Debug, PartialEq, Serialize)]
pub struct ResourceMonitorAgentMetric {
    pub metric: ResourceMetricKind,
    pub status: ResourceMonitorAgentMetricStatus,
    pub used: Option<u64>,
    pub total: Option<u64>,
    pub percent: Option<f64>,
    pub available: Option<u64>,
    pub free: Option<u64>,
    pub reason: Option<String>,
    #[serde(default)]
    pub gpus: Vec<ResourceMonitorAgentGpuDevice>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct ResourceMonitorAgentGpuDevice {
    pub id: String,
    pub label: String,
    pub compute_percent: f64,
    pub memory_used: u64,
    pub memory_total: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinuxNvmlDeviceSample {
    pub id: String,
    pub label: String,
    pub compute_percent: f64,
    pub memory_used: u64,
    pub memory_total: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowsGpuAdapterInfo {
    pub id: String,
    pub label: String,
    pub dedicated_video_memory: u64,
}

impl WindowsGpuAdapterInfo {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        dedicated_video_memory: u64,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            dedicated_video_memory,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WindowsGpuPdhSample {
    Engine {
        instance: String,
        utilization_percent: f64,
    },
    Memory {
        instance: String,
        bytes: u64,
    },
}

impl WindowsGpuPdhSample {
    pub fn engine(instance: impl Into<String>, utilization_percent: f64) -> Self {
        Self::Engine {
            instance: instance.into(),
            utilization_percent,
        }
    }

    pub fn memory(instance: impl Into<String>, bytes: u64) -> Self {
        Self::Memory {
            instance: instance.into(),
            bytes,
        }
    }
}

pub fn run_agent() -> Result<(), Box<dyn std::error::Error>> {
    print_event(&ResourceMonitorAgentEvent::Hello {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: current_target_os()?,
        arch: current_target_arch()?,
        capabilities: vec![
            "resource.cpu".to_string(),
            "resource.memory".to_string(),
            "resource.swap".to_string(),
            "resource.gpu".to_string(),
        ],
    })?;

    if std::env::args().any(|arg| arg == "--stream") {
        loop {
            print_snapshot_event()?;
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }

    print_snapshot_event()?;
    Ok(())
}

fn print_snapshot_event() -> Result<(), Box<dyn std::error::Error>> {
    print_event(&ResourceMonitorAgentEvent::Snapshot {
        metrics: collect_metrics(),
    })
}

fn print_event(event: &ResourceMonitorAgentEvent) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string(event)?);
    Ok(())
}

pub fn collect_metrics() -> Vec<ResourceMonitorAgentMetric> {
    let mut system = sysinfo::System::new_all();
    system.refresh_all();

    vec![
        ResourceMonitorAgentMetric {
            metric: ResourceMetricKind::Cpu,
            status: ResourceMonitorAgentMetricStatus::Available,
            used: Some(0),
            total: Some(100),
            percent: Some(normalize_percent(f64::from(system.global_cpu_usage()))),
            available: None,
            free: None,
            reason: None,
            gpus: Vec::new(),
        },
        capacity_metric(
            ResourceMetricKind::Memory,
            system.used_memory(),
            system.total_memory(),
            Some(system.available_memory()),
            None,
        ),
        capacity_metric(
            ResourceMetricKind::Swap,
            system.used_swap(),
            system.total_swap(),
            None,
            Some(system.free_swap()),
        ),
        collect_gpu_metric(),
    ]
}

fn capacity_metric(
    metric: ResourceMetricKind,
    used: u64,
    total: u64,
    available: Option<u64>,
    free: Option<u64>,
) -> ResourceMonitorAgentMetric {
    if total == 0 {
        if matches!(metric, ResourceMetricKind::Swap) {
            return ResourceMonitorAgentMetric {
                metric,
                status: ResourceMonitorAgentMetricStatus::Available,
                used: Some(0),
                total: Some(0),
                percent: Some(0.0),
                available,
                free,
                reason: None,
                gpus: Vec::new(),
            };
        }
        return ResourceMonitorAgentMetric {
            metric,
            status: ResourceMonitorAgentMetricStatus::Unavailable,
            used: None,
            total: None,
            percent: None,
            available,
            free,
            reason: Some("capacity total is zero".to_string()),
            gpus: Vec::new(),
        };
    }

    ResourceMonitorAgentMetric {
        metric,
        status: ResourceMonitorAgentMetricStatus::Available,
        used: Some(used),
        total: Some(total),
        percent: Some(normalize_percent((used as f64 / total as f64) * 100.0)),
        available,
        free,
        reason: None,
        gpus: Vec::new(),
    }
}

fn collect_gpu_metric() -> ResourceMonitorAgentMetric {
    #[cfg(target_os = "linux")]
    {
        return collect_linux_gpu_metric_from_sources(
            collect_linux_drm_gpu_devices_from_root(Path::new("/sys")),
            collect_linux_nvml_gpu_devices(),
        );
    }
    #[cfg(target_os = "windows")]
    {
        return collect_windows_gpu_pdh_metric().unwrap_or_else(unavailable_gpu_metric);
    }
    #[cfg(target_os = "macos")]
    {
        return unavailable_gpu_metric(
            "macOS GPU utilization is unavailable through a stable public helper API",
        );
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        unavailable_gpu_metric("GPU provider is unsupported on this platform")
    }
}

#[cfg(target_os = "windows")]
fn collect_windows_gpu_pdh_metric() -> Result<ResourceMonitorAgentMetric, String> {
    let mut samples = Vec::new();
    let adapters = collect_windows_dxgi_adapters()?;
    samples.extend(
        collect_windows_pdh_counter_array(
            r"\GPU Engine(*)\Utilization Percentage",
            WindowsPdhCounterFormat::Double,
        )?
        .into_iter()
        .filter_map(|sample| {
            sample
                .double_value
                .map(|value| WindowsGpuPdhSample::engine(sample.instance, value))
        }),
    );
    samples.extend(
        collect_windows_pdh_counter_array(
            r"\GPU Adapter Memory(*)\Dedicated Usage",
            WindowsPdhCounterFormat::Large,
        )?
        .into_iter()
        .filter_map(|sample| {
            sample.large_value.map(|value| {
                WindowsGpuPdhSample::memory(
                    format!("{}_dedicated", sample.instance),
                    value.max(0) as u64,
                )
            })
        }),
    );

    Ok(normalize_windows_gpu_pdh_samples(samples, adapters))
}

fn collect_linux_drm_gpu_metric_from_root(sys_root: &Path) -> ResourceMonitorAgentMetric {
    collect_linux_gpu_metric_from_sources(
        collect_linux_drm_gpu_devices_from_root(sys_root),
        Err("Linux NVML provider was not used for this DRM/sysfs fixture".to_string()),
    )
}

fn collect_linux_gpu_metric_from_sources(
    drm_devices: Result<Vec<ResourceMonitorAgentGpuDevice>, String>,
    nvml_devices: Result<Vec<LinuxNvmlDeviceSample>, String>,
) -> ResourceMonitorAgentMetric {
    let mut diagnostics = Vec::new();
    match drm_devices {
        Ok(devices) if !devices.is_empty() => return normalize_gpu_devices_metric(devices),
        Ok(_) => diagnostics
            .push("Linux DRM sysfs did not report VRAM metrics for any GPU devices".to_string()),
        Err(reason) => diagnostics.push(reason),
    }

    match nvml_devices {
        Ok(devices) if !devices.is_empty() => {
            return normalize_gpu_devices_metric(
                devices
                    .into_iter()
                    .map(|device| ResourceMonitorAgentGpuDevice {
                        id: device.id,
                        label: device.label,
                        compute_percent: device.compute_percent,
                        memory_used: device.memory_used,
                        memory_total: device.memory_total,
                    })
                    .collect(),
            );
        }
        Ok(_) => diagnostics.push("Linux NVML did not report any GPU devices".to_string()),
        Err(reason) => diagnostics.push(reason),
    }

    unavailable_gpu_metric(diagnostics.join("; "))
}

fn collect_linux_drm_gpu_devices_from_root(
    sys_root: &Path,
) -> Result<Vec<ResourceMonitorAgentGpuDevice>, String> {
    let drm_root = sys_root.join("class").join("drm");
    let entries = match fs::read_dir(&drm_root) {
        Ok(entries) => entries,
        Err(error) => {
            return Err(format!(
                "Linux DRM sysfs GPU provider unavailable at {}: {error}",
                drm_root.display()
            ));
        }
    };

    let mut devices = Vec::new();
    let mut diagnostics = Vec::new();

    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let card_path = entry.path();
        let card_id = entry.file_name().to_string_lossy().to_string();
        if !card_id.starts_with("card") || card_id.contains('-') {
            continue;
        }
        match linux_drm_gpu_device_metric(&card_id, &card_path.join("device")) {
            Ok(Some(device)) => devices.push(device),
            Ok(None) => {}
            Err(reason) => diagnostics.push(reason),
        }
    }

    if !diagnostics.is_empty() {
        return Err(diagnostics.join("; "));
    }

    Ok(devices)
}

fn linux_drm_gpu_device_metric(
    card_id: &str,
    device_path: &Path,
) -> Result<Option<ResourceMonitorAgentGpuDevice>, String> {
    let used_path = device_path.join("mem_info_vram_used");
    let total_path = device_path.join("mem_info_vram_total");
    if !used_path.exists() || !total_path.exists() {
        return Ok(None);
    }

    let memory_used = read_u64_file(&used_path)?;
    let memory_total = read_u64_file(&total_path)?;
    let label = read_first_existing_trimmed(&[
        device_path.join("product_name"),
        device_path.join("device_name"),
        device_path.join("uevent"),
    ])
    .unwrap_or_else(|| card_id.to_string());

    Ok(Some(ResourceMonitorAgentGpuDevice {
        id: card_id.to_string(),
        label,
        compute_percent: 0.0,
        memory_used,
        memory_total,
    }))
}

#[cfg(target_os = "linux")]
fn collect_linux_nvml_gpu_devices() -> Result<Vec<LinuxNvmlDeviceSample>, String> {
    linux_nvml::collect_devices()
}

#[cfg(target_os = "linux")]
mod linux_nvml {
    use std::{
        ffi::{c_char, c_uint, c_ulonglong, c_void, CStr},
        ptr,
    };

    use libloading::Library;

    use super::LinuxNvmlDeviceSample;

    type NvmlReturn = c_uint;
    type NvmlDevice = *mut c_void;

    const NVML_SUCCESS: NvmlReturn = 0;

    #[repr(C)]
    struct NvmlMemory {
        total: c_ulonglong,
        free: c_ulonglong,
        used: c_ulonglong,
    }

    #[repr(C)]
    struct NvmlUtilization {
        gpu: c_uint,
        memory: c_uint,
    }

    type NvmlInit = unsafe extern "C" fn() -> NvmlReturn;
    type NvmlShutdown = unsafe extern "C" fn() -> NvmlReturn;
    type NvmlDeviceGetCount = unsafe extern "C" fn(*mut c_uint) -> NvmlReturn;
    type NvmlDeviceGetHandleByIndex = unsafe extern "C" fn(c_uint, *mut NvmlDevice) -> NvmlReturn;
    type NvmlDeviceGetName = unsafe extern "C" fn(NvmlDevice, *mut c_char, c_uint) -> NvmlReturn;
    type NvmlDeviceGetMemoryInfo = unsafe extern "C" fn(NvmlDevice, *mut NvmlMemory) -> NvmlReturn;
    type NvmlDeviceGetUtilizationRates =
        unsafe extern "C" fn(NvmlDevice, *mut NvmlUtilization) -> NvmlReturn;

    struct NvmlSession {
        shutdown: NvmlShutdown,
    }

    impl Drop for NvmlSession {
        fn drop(&mut self) {
            unsafe {
                (self.shutdown)();
            }
        }
    }

    pub fn collect_devices() -> Result<Vec<LinuxNvmlDeviceSample>, String> {
        let library = load_library()?;
        unsafe {
            let init = *library
                .get::<NvmlInit>(b"nvmlInit_v2")
                .map_err(|error| format!("Linux NVML nvmlInit_v2 unavailable: {error}"))?;
            let shutdown = *library
                .get::<NvmlShutdown>(b"nvmlShutdown")
                .map_err(|error| format!("Linux NVML nvmlShutdown unavailable: {error}"))?;
            let get_count = *library
                .get::<NvmlDeviceGetCount>(b"nvmlDeviceGetCount_v2")
                .map_err(|error| {
                    format!("Linux NVML nvmlDeviceGetCount_v2 unavailable: {error}")
                })?;
            let get_handle = *library
                .get::<NvmlDeviceGetHandleByIndex>(b"nvmlDeviceGetHandleByIndex_v2")
                .map_err(|error| {
                    format!("Linux NVML nvmlDeviceGetHandleByIndex_v2 unavailable: {error}")
                })?;
            let get_name = *library
                .get::<NvmlDeviceGetName>(b"nvmlDeviceGetName")
                .map_err(|error| format!("Linux NVML nvmlDeviceGetName unavailable: {error}"))?;
            let get_memory = *library
                .get::<NvmlDeviceGetMemoryInfo>(b"nvmlDeviceGetMemoryInfo")
                .map_err(|error| {
                    format!("Linux NVML nvmlDeviceGetMemoryInfo unavailable: {error}")
                })?;
            let get_utilization = *library
                .get::<NvmlDeviceGetUtilizationRates>(b"nvmlDeviceGetUtilizationRates")
                .map_err(|error| {
                    format!("Linux NVML nvmlDeviceGetUtilizationRates unavailable: {error}")
                })?;

            check(init(), "nvmlInit_v2")?;
            let _session = NvmlSession { shutdown };

            let mut count = 0;
            check(get_count(&mut count), "nvmlDeviceGetCount_v2")?;
            let mut devices = Vec::new();
            for index in 0..count {
                let mut handle = ptr::null_mut();
                check(
                    get_handle(index, &mut handle),
                    "nvmlDeviceGetHandleByIndex_v2",
                )?;

                let label =
                    device_name(get_name, handle).unwrap_or_else(|_| format!("NVIDIA GPU {index}"));
                let mut memory = NvmlMemory {
                    total: 0,
                    free: 0,
                    used: 0,
                };
                check(get_memory(handle, &mut memory), "nvmlDeviceGetMemoryInfo")?;

                let compute_percent = match device_utilization(get_utilization, handle) {
                    Ok(utilization) => f64::from(utilization.gpu),
                    Err(_) => 0.0,
                };

                devices.push(LinuxNvmlDeviceSample {
                    id: format!("nvml-{index}"),
                    label,
                    compute_percent,
                    memory_used: memory.used as u64,
                    memory_total: memory.total as u64,
                });
            }
            Ok(devices)
        }
    }

    fn load_library() -> Result<Library, String> {
        for name in ["libnvidia-ml.so.1", "libnvidia-ml.so"] {
            match unsafe { Library::new(name) } {
                Ok(library) => return Ok(library),
                Err(_) => {}
            }
        }
        Err("Linux NVML library libnvidia-ml.so.1 was not found".to_string())
    }

    fn check(code: NvmlReturn, operation: &str) -> Result<(), String> {
        if code == NVML_SUCCESS {
            Ok(())
        } else {
            Err(format!("Linux NVML {operation} failed with code {code}"))
        }
    }

    unsafe fn device_name(
        get_name: NvmlDeviceGetName,
        handle: NvmlDevice,
    ) -> Result<String, String> {
        let mut buffer = [0 as c_char; 96];
        check(
            get_name(handle, buffer.as_mut_ptr(), buffer.len() as c_uint),
            "nvmlDeviceGetName",
        )?;
        let label = CStr::from_ptr(buffer.as_ptr())
            .to_string_lossy()
            .trim()
            .to_string();
        if label.is_empty() {
            Err("Linux NVML device name was empty".to_string())
        } else {
            Ok(label)
        }
    }

    unsafe fn device_utilization(
        get_utilization: NvmlDeviceGetUtilizationRates,
        handle: NvmlDevice,
    ) -> Result<NvmlUtilization, String> {
        let mut utilization = NvmlUtilization { gpu: 0, memory: 0 };
        check(
            get_utilization(handle, &mut utilization),
            "nvmlDeviceGetUtilizationRates",
        )?;
        Ok(utilization)
    }
}

fn read_u64_file(path: &Path) -> Result<u64, String> {
    let value = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    value
        .trim()
        .parse::<u64>()
        .map_err(|error| format!("{} is not an unsigned integer: {error}", path.display()))
}

fn read_first_existing_trimmed(paths: &[PathBuf]) -> Option<String> {
    for path in paths {
        let Ok(value) = fs::read_to_string(path) else {
            continue;
        };
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.lines().next().unwrap_or(trimmed).to_string());
        }
    }
    None
}

fn normalize_windows_gpu_pdh_samples(
    samples: Vec<WindowsGpuPdhSample>,
    adapters: Vec<WindowsGpuAdapterInfo>,
) -> ResourceMonitorAgentMetric {
    let mut devices = BTreeMap::<String, ResourceMonitorAgentGpuDevice>::new();

    for adapter in adapters {
        devices.insert(
            adapter.id.clone(),
            ResourceMonitorAgentGpuDevice {
                id: adapter.id,
                label: adapter.label,
                compute_percent: 0.0,
                memory_used: 0,
                memory_total: adapter.dedicated_video_memory,
            },
        );
    }

    for sample in samples {
        match sample {
            WindowsGpuPdhSample::Engine {
                instance,
                utilization_percent,
            } => {
                let Some(id) = windows_gpu_luid_from_engine_instance(&instance) else {
                    continue;
                };
                let entry =
                    devices
                        .entry(id.clone())
                        .or_insert_with(|| ResourceMonitorAgentGpuDevice {
                            id: id.clone(),
                            label: format!("GPU {id}"),
                            compute_percent: 0.0,
                            memory_used: 0,
                            memory_total: 0,
                        });
                entry.compute_percent =
                    normalize_percent(entry.compute_percent + utilization_percent);
            }
            WindowsGpuPdhSample::Memory { instance, bytes } => {
                let Some((id, memory_kind)) = windows_gpu_memory_instance_parts(&instance) else {
                    continue;
                };
                let entry =
                    devices
                        .entry(id.clone())
                        .or_insert_with(|| ResourceMonitorAgentGpuDevice {
                            id: id.clone(),
                            label: format!("GPU {id}"),
                            compute_percent: 0.0,
                            memory_used: 0,
                            memory_total: 0,
                        });
                match memory_kind {
                    WindowsGpuMemoryCounterKind::DedicatedUsage => entry.memory_used = bytes,
                    WindowsGpuMemoryCounterKind::DedicatedLimit => entry.memory_total = bytes,
                }
            }
        }
    }

    let devices: Vec<ResourceMonitorAgentGpuDevice> = devices
        .into_values()
        .filter(|device| {
            device.compute_percent > 0.0 || device.memory_used > 0 || device.memory_total > 0
        })
        .collect();
    if devices.is_empty() {
        return unavailable_gpu_metric("Windows PDH did not report any GPU devices");
    }

    normalize_gpu_devices_metric(devices)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsGpuMemoryCounterKind {
    DedicatedUsage,
    DedicatedLimit,
}

fn windows_gpu_luid_from_engine_instance(instance: &str) -> Option<String> {
    windows_luid_id_from_instance(instance)
}

fn windows_gpu_memory_instance_parts(
    instance: &str,
) -> Option<(String, WindowsGpuMemoryCounterKind)> {
    let id = windows_luid_id_from_instance(instance)?;
    let lower = instance.to_ascii_lowercase();
    if lower.ends_with("_dedicated_limit") {
        Some((id, WindowsGpuMemoryCounterKind::DedicatedLimit))
    } else if lower.ends_with("_dedicated") {
        Some((id, WindowsGpuMemoryCounterKind::DedicatedUsage))
    } else {
        None
    }
}

fn windows_luid_id_from_instance(instance: &str) -> Option<String> {
    let parts: Vec<&str> = instance.split('_').collect();
    for window in parts.windows(3) {
        if window[0].eq_ignore_ascii_case("luid")
            && is_windows_hex_word(window[1])
            && is_windows_hex_word(window[2])
        {
            return Some(format!(
                "luid_{}_{}",
                window[1].to_ascii_lowercase(),
                window[2].to_ascii_lowercase()
            ));
        }
    }
    None
}

fn is_windows_hex_word(value: &str) -> bool {
    value.len() == 10
        && value[..2].eq_ignore_ascii_case("0x")
        && value[2..].chars().all(|ch| ch.is_ascii_hexdigit())
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
enum WindowsPdhCounterFormat {
    Double,
    Large,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct WindowsPdhCounterSample {
    instance: String,
    double_value: Option<f64>,
    large_value: Option<i64>,
}

#[cfg(target_os = "windows")]
fn collect_windows_dxgi_adapters() -> Result<Vec<WindowsGpuAdapterInfo>, String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ERROR_NOT_FOUND};

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }
        .map_err(|error| format!("Windows DXGI factory creation failed: {error}"))?;
    let mut adapters = Vec::new();
    let mut index = 0_u32;
    loop {
        match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => {
                let desc = unsafe { adapter.GetDesc1() }
                    .map_err(|error| format!("Windows DXGI adapter description failed: {error}"))?;
                let id = windows_luid_id(desc.AdapterLuid.LowPart, desc.AdapterLuid.HighPart);
                let label = windows_utf16_array_to_string(&desc.Description)
                    .unwrap_or_else(|| format!("GPU {id}"));
                adapters.push(WindowsGpuAdapterInfo::new(
                    id,
                    label,
                    desc.DedicatedVideoMemory as u64,
                ));
            }
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(format!("Windows DXGI adapter enumeration failed: {error}")),
        }
        index += 1;
    }

    if adapters.is_empty() {
        return Err("Windows DXGI did not report any GPU adapters".to_string());
    }

    Ok(adapters)
}

#[cfg(target_os = "windows")]
fn windows_luid_id(low_part: u32, high_part: i32) -> String {
    format!("luid_0x{:08x}_0x{:08x}", high_part as u32, low_part)
}

#[cfg(target_os = "windows")]
fn windows_utf16_array_to_string(value: &[u16]) -> Option<String> {
    let end = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    let label = String::from_utf16_lossy(&value[..end]).trim().to_string();
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

#[cfg(target_os = "windows")]
fn collect_windows_pdh_counter_array(
    counter_path: &str,
    format: WindowsPdhCounterFormat,
) -> Result<Vec<WindowsPdhCounterSample>, String> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr, thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Performance::{
            PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
            PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W,
            PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY, PDH_INVALID_DATA,
            PDH_MORE_DATA,
        },
    };

    struct Query(PDH_HQUERY);
    impl Drop for Query {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.0);
            }
        }
    }

    let mut query: PDH_HQUERY = ptr::null_mut();
    let status = unsafe { PdhOpenQueryW(ptr::null(), 0, &mut query) };
    if status != ERROR_SUCCESS {
        return Err(format!("Windows PDH open query failed: 0x{status:08x}"));
    }
    let query = Query(query);

    let mut counter: PDH_HCOUNTER = ptr::null_mut();
    let wide_path: Vec<u16> = OsStr::new(counter_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let status = unsafe { PdhAddEnglishCounterW(query.0, wide_path.as_ptr(), 0, &mut counter) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Windows PDH add counter {counter_path} failed: 0x{status:08x}"
        ));
    }

    let first_status = unsafe { PdhCollectQueryData(query.0) };
    if first_status != ERROR_SUCCESS && first_status != PDH_INVALID_DATA {
        return Err(format!(
            "Windows PDH first collection failed for {counter_path}: 0x{first_status:08x}"
        ));
    }
    thread::sleep(Duration::from_millis(120));
    let status = unsafe { PdhCollectQueryData(query.0) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Windows PDH collection failed for {counter_path}: 0x{status:08x}"
        ));
    }

    let pdh_format = match format {
        WindowsPdhCounterFormat::Double => PDH_FMT_DOUBLE,
        WindowsPdhCounterFormat::Large => PDH_FMT_LARGE,
    };
    let mut buffer_size = 0_u32;
    let mut item_count = 0_u32;
    let status = unsafe {
        PdhGetFormattedCounterArrayW(
            counter,
            pdh_format,
            &mut buffer_size,
            &mut item_count,
            ptr::null_mut(),
        )
    };
    if status != PDH_MORE_DATA {
        return Err(format!(
            "Windows PDH counter array sizing failed for {counter_path}: 0x{status:08x}"
        ));
    }

    let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
    let item_capacity = (buffer_size as usize + item_size - 1) / item_size;
    let mut items = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); item_capacity];
    let status = unsafe {
        PdhGetFormattedCounterArrayW(
            counter,
            pdh_format,
            &mut buffer_size,
            &mut item_count,
            items.as_mut_ptr(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Windows PDH counter array read failed for {counter_path}: 0x{status:08x}"
        ));
    }

    let mut samples = Vec::new();
    for item in items.into_iter().take(item_count as usize) {
        let instance = wide_ptr_to_string(item.szName);
        if instance.is_empty() {
            continue;
        }
        let c_status = item.FmtValue.CStatus;
        if c_status != ERROR_SUCCESS {
            continue;
        }
        let sample = match format {
            WindowsPdhCounterFormat::Double => WindowsPdhCounterSample {
                instance,
                double_value: Some(unsafe { item.FmtValue.Anonymous.doubleValue }),
                large_value: None,
            },
            WindowsPdhCounterFormat::Large => WindowsPdhCounterSample {
                instance,
                double_value: None,
                large_value: Some(unsafe { item.FmtValue.Anonymous.largeValue }),
            },
        };
        samples.push(sample);
    }

    Ok(samples)
}

#[cfg(target_os = "windows")]
fn wide_ptr_to_string(value: windows_sys::core::PCWSTR) -> String {
    if value.is_null() {
        return String::new();
    }
    let mut len = 0_usize;
    unsafe {
        while *value.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
    }
}

fn normalize_gpu_devices_metric(
    devices: Vec<ResourceMonitorAgentGpuDevice>,
) -> ResourceMonitorAgentMetric {
    let used = devices
        .iter()
        .fold(0_u64, |sum, gpu| sum.saturating_add(gpu.memory_used));
    let total = devices
        .iter()
        .fold(0_u64, |sum, gpu| sum.saturating_add(gpu.memory_total));
    let compute_percent =
        devices.iter().map(|gpu| gpu.compute_percent).sum::<f64>() / devices.len() as f64;

    ResourceMonitorAgentMetric {
        metric: ResourceMetricKind::Gpu,
        status: ResourceMonitorAgentMetricStatus::Available,
        used: Some(used),
        total: Some(total),
        percent: Some(normalize_percent(compute_percent)),
        available: None,
        free: Some(total.saturating_sub(used)),
        reason: None,
        gpus: devices,
    }
}

fn unavailable_gpu_metric(reason: impl Into<String>) -> ResourceMonitorAgentMetric {
    ResourceMonitorAgentMetric {
        metric: ResourceMetricKind::Gpu,
        status: ResourceMonitorAgentMetricStatus::Unavailable,
        used: None,
        total: None,
        percent: None,
        available: None,
        free: None,
        reason: Some(reason.into()),
        gpus: Vec::new(),
    }
}

fn normalize_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn current_target_os() -> Result<TargetOs, String> {
    if cfg!(target_os = "linux") {
        Ok(TargetOs::Linux)
    } else if cfg!(target_os = "macos") {
        Ok(TargetOs::Macos)
    } else if cfg!(target_os = "windows") {
        Ok(TargetOs::Windows)
    } else {
        Err("unsupported nocturne-resource-monitor-agent target OS".to_string())
    }
}

fn current_target_arch() -> Result<TargetArch, String> {
    if cfg!(target_arch = "x86_64") {
        Ok(TargetArch::X86_64)
    } else if cfg!(target_arch = "aarch64") {
        Ok(TargetArch::Aarch64)
    } else if cfg!(target_arch = "arm") {
        Ok(TargetArch::Armv7)
    } else if cfg!(target_arch = "x86") {
        Ok(TargetArch::I686)
    } else {
        Err("unsupported nocturne-resource-monitor-agent target architecture".to_string())
    }
}

pub fn collect_linux_drm_gpu_metric_from_root_for_test(
    sys_root: &Path,
) -> ResourceMonitorAgentMetric {
    collect_linux_drm_gpu_metric_from_root(sys_root)
}

pub fn collect_linux_gpu_metric_from_sources_for_test(
    sys_root: &Path,
    nvml_devices: Vec<LinuxNvmlDeviceSample>,
) -> ResourceMonitorAgentMetric {
    collect_linux_gpu_metric_from_sources(
        collect_linux_drm_gpu_devices_from_root(sys_root),
        Ok(nvml_devices),
    )
}

pub fn normalize_windows_gpu_pdh_samples_for_test(
    samples: Vec<WindowsGpuPdhSample>,
    adapters: Vec<WindowsGpuAdapterInfo>,
) -> ResourceMonitorAgentMetric {
    normalize_windows_gpu_pdh_samples(samples, adapters)
}
