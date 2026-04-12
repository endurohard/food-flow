import pkg from 'pg';
const { Pool } = pkg;

export class HRService {
  private pool: InstanceType<typeof Pool>;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }

  // ========== STAFF PROFILES ==========

  async listStaff(filters: { enterpriseId?: string; position?: string; isActive?: boolean }): Promise<any[]> {
    const conds: string[] = [];
    const vals: any[] = [];
    let p = 1;
    if (filters.enterpriseId) { conds.push(`sp.enterprise_id = $${p++}`); vals.push(filters.enterpriseId); }
    if (filters.position) { conds.push(`sp.position = $${p++}`); vals.push(filters.position); }
    if (filters.isActive !== undefined) { conds.push(`sp.is_active = $${p++}`); vals.push(filters.isActive); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT sp.*, u.email, u.first_name, u.last_name, u.phone, u.role
       FROM staff_profiles sp
       INNER JOIN users u ON sp.user_id = u.id
       ${where}
       ORDER BY u.last_name, u.first_name`, vals
    );
    return result.rows;
  }

  async getStaffProfile(userId: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT sp.*, u.email, u.first_name, u.last_name, u.phone, u.role
       FROM staff_profiles sp INNER JOIN users u ON sp.user_id = u.id WHERE sp.user_id = $1`, [userId]
    );
    return result.rows[0] || null;
  }

  async createStaffProfile(data: any, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO staff_profiles (user_id, enterprise_id, position, department, hire_date, hourly_rate, monthly_salary, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [data.userId, enterpriseId || null, data.position || null, data.department || null,
       data.hireDate || null, data.hourlyRate || null, data.monthlySalary || null, data.notes || null]
    );
    return result.rows[0];
  }

  async updateStaffProfile(userId: string, data: any, enterpriseId?: string): Promise<any> {
    const map: Record<string, string> = {
      position: 'position', department: 'department', hireDate: 'hire_date',
      terminationDate: 'termination_date', hourlyRate: 'hourly_rate',
      monthlySalary: 'monthly_salary', bankDetails: 'bank_details',
      emergencyContact: 'emergency_contact', notes: 'notes', isActive: 'is_active'
    };
    const fields: string[] = []; const values: any[] = []; let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) {
        fields.push(`${col} = $${p++}`);
        values.push(typeof data[k] === 'object' && data[k] !== null ? JSON.stringify(data[k]) : data[k]);
      }
    }
    if (!fields.length) return null;
    const whereConds = [`user_id = $${p++}`];
    values.push(userId);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE staff_profiles SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  // ========== WORK SCHEDULES ==========

  async getSchedules(filters: { userId?: string; restaurantId?: string; dateFrom?: string; dateTo?: string }): Promise<any[]> {
    const conds: string[] = []; const vals: any[] = []; let p = 1;
    if (filters.userId) { conds.push(`ws.user_id = $${p++}`); vals.push(filters.userId); }
    if (filters.restaurantId) { conds.push(`ws.restaurant_id = $${p++}`); vals.push(filters.restaurantId); }
    if (filters.dateFrom) { conds.push(`ws.shift_date >= $${p++}`); vals.push(filters.dateFrom); }
    if (filters.dateTo) { conds.push(`ws.shift_date <= $${p++}`); vals.push(filters.dateTo); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT ws.*, u.first_name, u.last_name
       FROM work_schedules ws
       INNER JOIN users u ON ws.user_id = u.id
       ${where}
       ORDER BY ws.shift_date ASC, ws.start_time ASC`, vals
    );
    return result.rows;
  }

  async createSchedule(data: any, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO work_schedules (user_id, restaurant_id, enterprise_id, shift_date, start_time, end_time, break_minutes, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [data.userId, data.restaurantId || null, enterpriseId || null,
       data.shiftDate, data.startTime, data.endTime, data.breakMinutes || 0, data.notes || null]
    );
    return result.rows[0];
  }

  async updateSchedule(scheduleId: string, data: any, enterpriseId?: string): Promise<any> {
    const map: Record<string, string> = {
      shiftDate: 'shift_date', startTime: 'start_time', endTime: 'end_time',
      breakMinutes: 'break_minutes', status: 'status', actualStart: 'actual_start',
      actualEnd: 'actual_end', notes: 'notes'
    };
    const fields: string[] = []; const values: any[] = []; let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) { fields.push(`${col} = $${p++}`); values.push(data[k]); }
    }
    if (!fields.length) return null;
    const whereConds = [`id = $${p++}`];
    values.push(scheduleId);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE work_schedules SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  async deleteSchedule(scheduleId: string, enterpriseId?: string): Promise<boolean> {
    const conds = ['id = $1'];
    const vals: any[] = [scheduleId];
    if (enterpriseId) {
      conds.push(`enterprise_id = $2`);
      vals.push(enterpriseId);
    }
    const r = await this.pool.query(
      `DELETE FROM work_schedules WHERE ${conds.join(' AND ')}`, vals
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ========== TIME ENTRIES ==========

  async clockIn(userId: string, restaurantId?: string, enterpriseId?: string): Promise<any> {
    // Check if already clocked in
    const existing = await this.pool.query(
      `SELECT id FROM time_entries WHERE user_id = $1 AND clock_out IS NULL`, [userId]
    );
    if (existing.rows.length > 0) throw new Error('Already clocked in');

    const result = await this.pool.query(
      `INSERT INTO time_entries (user_id, restaurant_id, enterprise_id, clock_in)
       VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [userId, restaurantId || null, enterpriseId || null]
    );
    return result.rows[0];
  }

  async clockOut(userId: string): Promise<any> {
    const result = await this.pool.query(
      `UPDATE time_entries
       SET clock_out = NOW(),
           total_hours = EXTRACT(EPOCH FROM (NOW() - clock_in)) / 3600.0
       WHERE user_id = $1 AND clock_out IS NULL
       RETURNING *`,
      [userId]
    );
    return result.rows[0] || null;
  }

  async getTimeEntries(filters: { userId?: string; dateFrom?: string; dateTo?: string }): Promise<any[]> {
    const conds: string[] = []; const vals: any[] = []; let p = 1;
    if (filters.userId) { conds.push(`te.user_id = $${p++}`); vals.push(filters.userId); }
    if (filters.dateFrom) { conds.push(`te.clock_in >= $${p++}`); vals.push(filters.dateFrom); }
    if (filters.dateTo) { conds.push(`te.clock_in <= $${p++}`); vals.push(filters.dateTo); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT te.*, u.first_name, u.last_name
       FROM time_entries te INNER JOIN users u ON te.user_id = u.id
       ${where} ORDER BY te.clock_in DESC`, vals
    );
    return result.rows;
  }

  // ========== PAYROLL ==========

  async calculatePayroll(userId: string, periodStart: string, periodEnd: string, enterpriseId?: string): Promise<any> {
    // Get staff profile
    const profile = await this.getStaffProfile(userId);
    if (!profile) throw new Error('Staff profile not found');

    // Get time entries for period
    const entries = await this.pool.query(
      `SELECT SUM(total_hours) as total_hours, SUM(overtime_hours) as overtime
       FROM time_entries WHERE user_id = $1 AND clock_in >= $2 AND clock_in <= $3`,
      [userId, periodStart, periodEnd]
    );

    const hoursWorked = parseFloat(entries.rows[0]?.total_hours) || 0;
    const overtimeHours = parseFloat(entries.rows[0]?.overtime) || 0;

    // Calculate
    let baseSalary = 0;
    if (profile.monthly_salary) {
      baseSalary = parseFloat(profile.monthly_salary);
    } else if (profile.hourly_rate) {
      baseSalary = hoursWorked * parseFloat(profile.hourly_rate);
    }
    const overtimePay = overtimeHours * (parseFloat(profile.hourly_rate) || 0) * 1.5;
    const grossPay = baseSalary + overtimePay;
    const taxAmount = grossPay * 0.13; // Simplified flat rate
    const netPay = grossPay - taxAmount;

    const result = await this.pool.query(
      `INSERT INTO payroll (user_id, enterprise_id, period_start, period_end,
        base_salary, hours_worked, overtime_pay, gross_pay, tax_amount, net_pay, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft') RETURNING *`,
      [userId, enterpriseId || null, periodStart, periodEnd,
       baseSalary, hoursWorked, overtimePay, grossPay, taxAmount, netPay]
    );
    return result.rows[0];
  }

  async getPayroll(filters: { userId?: string; enterpriseId?: string; status?: string }): Promise<any[]> {
    const conds: string[] = []; const vals: any[] = []; let p = 1;
    if (filters.userId) { conds.push(`p.user_id = $${p++}`); vals.push(filters.userId); }
    if (filters.enterpriseId) { conds.push(`p.enterprise_id = $${p++}`); vals.push(filters.enterpriseId); }
    if (filters.status) { conds.push(`p.status = $${p++}`); vals.push(filters.status); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT p.*, u.first_name, u.last_name
       FROM payroll p INNER JOIN users u ON p.user_id = u.id
       ${where} ORDER BY p.period_start DESC`, vals
    );
    return result.rows;
  }

  async approvePayroll(payrollId: string, enterpriseId?: string): Promise<any> {
    const conds = ['id = $1'];
    const vals: any[] = [payrollId];
    if (enterpriseId) {
      conds.push(`enterprise_id = $2`);
      vals.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE payroll SET status = 'approved' WHERE ${conds.join(' AND ')} RETURNING *`, vals
    );
    return result.rows[0] || null;
  }

  async markPayrollPaid(payrollId: string, enterpriseId?: string): Promise<any> {
    const conds = ['id = $1'];
    const vals: any[] = [payrollId];
    if (enterpriseId) {
      conds.push(`enterprise_id = $2`);
      vals.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE payroll SET status = 'paid', paid_at = NOW() WHERE ${conds.join(' AND ')} RETURNING *`, vals
    );
    return result.rows[0] || null;
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export default HRService;
